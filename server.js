const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
app.disable("x-powered-by");
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean);
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin not allowed by CORS policy"));
} }));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const now = () => new Date().toISOString();
const clean = (v, max=500) => String(v ?? "").trim().slice(0,max);
const norm = (s) => clean(s,300).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const words = (s) => clean(s,1000).toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).filter(Boolean);
const GENERIC_BRAND_TERMS = new Set(["official","support","help","login","app","apps","shop","store","secure","security","service","services","online","website","company","group","global","india","team","customer","care","account","portal","home","page","site","the","inc","ltd","limited"]);
const isGenericBrandTerm = (term) => {
  const tokens = words(term);
  return !tokens.length || tokens.every(token => GENERIC_BRAND_TERMS.has(token)) || norm(term).length < 4;
};
const containsTokenPhrase = (haystack, needle) => {
  if (!haystack.length || !needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true;
  }
  return false;
};
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0,24);
const emptyBrand = () => ({
  name: "", logoUrl: "", website: "", description: "", keywords: [],
  officialSocial: [], officialApps: [], createdAt: null, updatedAt: null
});
const seed = {
  brand: emptyBrand(),
  // Never seed fake candidates into the live monitoring workflow.
  candidates: [], findings: [], scans: []
};

let store = null;
let mongoClient = null;
let mongoCollection = null;
let persistence = "local-json";

function sanitizeLoadedStore(loaded) {
  const next = loaded && typeof loaded === "object" ? loaded : structuredClone(seed);
  next.brand = next.brand && typeof next.brand === "object" ? next.brand : emptyBrand();
  next.candidates = Array.isArray(next.candidates) ? next.candidates : [];
  next.findings = Array.isArray(next.findings) ? next.findings : [];
  next.scans = Array.isArray(next.scans) ? next.scans : [];

  // Migrate older demo builds: their default Trinetra identity and example.invalid
  // candidates were synthetic and must never appear as live discoveries.
  const oldDefaultBrand = next.brand.name === "Trinetra" &&
    String(next.brand.website || "").includes("trinetra.example") &&
    (next.brand.officialSocial || []).some(a => String(a.url || "").includes("trinetra_official"));
  if (oldDefaultBrand) next.brand = emptyBrand();
  const isSynthetic = item => /seeded demo|seeded official control/i.test(String(item.source || "")) ||
    /example\.invalid|trinetra\.example/i.test(String(item.url || ""));
  const removedFingerprints = new Set(next.findings.filter(isSynthetic).map(f => f.fingerprint).filter(Boolean));
  next.candidates = next.candidates.filter(c => !isSynthetic(c));
  next.findings = next.findings.filter(f => !isSynthetic(f) && !removedFingerprints.has(f.fingerprint));
  if (!next.brand.name) {
    next.candidates = [];
    next.findings = [];
    next.scans = [];
  }
  return next;
}

async function initStore() {
  if (process.env.NODE_ENV === "production" && !process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required in production. Configure MongoDB Atlas before deploying.");
  }
  if (process.env.MONGODB_URI) {
    try {
      mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 7000 });
      await mongoClient.connect();
      const dbName = process.env.MONGODB_DB || "brandshield";
      mongoCollection = mongoClient.db(dbName).collection("workspace");
      const existing = await mongoCollection.findOne({_id:"primary"});
      store = sanitizeLoadedStore(existing?.data || structuredClone(seed));
      persistence = "mongodb";
      await persist();
      console.log(`Connected to MongoDB database ${dbName}`);
      return;
    } catch (e) {
      console.error("MongoDB connection failed:", e.message);
      if (process.env.NODE_ENV === "production") throw new Error("MongoDB connection failed in production; refusing to start with ephemeral local storage.");
      console.error("Continuing with local JSON persistence for local development only.");
    }
  }
  fs.mkdirSync(DATA_DIR,{recursive:true});
  try {
    store = sanitizeLoadedStore(JSON.parse(fs.readFileSync(STORE_FILE,"utf8")));
    persistence = "local-json";
    await persist();
  } catch {
    store = structuredClone(seed);
    persistence = "local-json";
    await persist();
  }
}
async function persist() {
  if (mongoCollection) {
    await mongoCollection.updateOne({_id:"primary"},{$set:{data:store,updatedAt:now()}},{upsert:true});
  } else {
    fs.mkdirSync(DATA_DIR,{recursive:true});
    const temp = STORE_FILE + ".tmp";
    fs.writeFileSync(temp,JSON.stringify(store,null,2),"utf8");
    fs.renameSync(temp,STORE_FILE);
  }
}

function canonicalUrl(input) {
  try {
    const raw = clean(input, 1000);
    if (!raw) return "";
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "");
    // Keep app identity query parameters (e.g. Google Play's ?id=package.name),
    // while ignoring analytics/tracking parameters on ordinary profile URLs.
    const identityParams = ["id", "appid", "bundleid", "pkg", "package"];
    const stableParams = [...u.searchParams.entries()]
      .filter(([key]) => identityParams.includes(key.toLowerCase()))
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    const query = stableParams.length ? `?${new URLSearchParams(stableParams).toString()}` : "";
    return `${host}${pathname}${query}`.toLowerCase();
  } catch { return clean(input, 1000).toLowerCase().replace(/\/+$/, ""); }
}
function platformKey(value) {
  const v = clean(value,100).toLowerCase().replace(/^www\./, "");
  if (v.includes("instagram")) return "instagram.com";
  if (v.includes("facebook")) return "facebook.com";
  if (v === "x" || v.includes("twitter") || v === "x.com") return "x.com";
  if (v.includes("tiktok")) return "tiktok.com";
  if (v.includes("linkedin")) return "linkedin.com";
  return v;
}
function isOfficial(candidate) {
  const c = candidate;
  if (c.type === "social") {
    const handle = clean(c.handle,150).replace(/^@/,"").toLowerCase();
    const url = canonicalUrl(c.url);
    const candidatePlatform = platformKey(c.platform);
    return (store.brand.officialSocial||[]).some(a => {
      const officialUrl = canonicalUrl(a.url);
      const sameUrl = !!url && !!officialUrl && url === officialUrl;
      const officialPlatform = platformKey(a.platform || a.url);
      const samePlatformHandle = !!handle && !!candidatePlatform && candidatePlatform === officialPlatform && clean(a.handle,150).replace(/^@/,"").toLowerCase() === handle;
      return sameUrl || samePlatformHandle;
    });
  }
  const appName = norm(c.name);
  const packageId = clean(c.packageId,200).toLowerCase();
  const publisher = norm(c.publisher);
  const url = canonicalUrl(c.url);
  return (store.brand.officialApps||[]).some(a =>
    (packageId && clean(a.packageId,200).toLowerCase()===packageId) ||
    (url && canonicalUrl(a.url)===url) ||
    (publisher && norm(a.developer)===publisher && appName && norm(a.name)===appName)
  );
}
function levenshtein(a,b) {
  if (a===b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const cur=[i];
    for(let j=1;j<=b.length;j++) cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev=cur;
  }
  return prev[b.length];
}
function similarity(a,b) {
  const x=norm(a), y=norm(b);
  if(!x||!y) return 0;
  if(x===y) return 1;
  return Math.max(0,1-levenshtein(x,y)/Math.max(x.length,y.length));
}
function analyzeCandidate(raw) {
  const c = {
    type: raw.type==="app"?"app":"social",
    platform:clean(raw.platform || (raw.type==="app"?"App store":"Social media"),100),
    name:clean(raw.name,200), handle:clean(raw.handle,150), url:clean(raw.url,1000),
    description:clean(raw.description,2000), publisher:clean(raw.publisher,200),
    packageId:clean(raw.packageId,200), indicators:Array.isArray(raw.indicators)?raw.indicators.map(x=>clean(x,200)).filter(Boolean).slice(0,30):[],
    source:clean(raw.source||"Analyst-submitted candidate",150)
  };
  if (!c.name) throw new Error("Candidate name is required.");
  if (c.type==="social" && !c.handle && !c.url) throw new Error("Provide a social handle or profile URL.");
  if (c.type==="app" && !c.publisher && !c.packageId && !c.url) throw new Error("Provide an app URL, publisher, or package ID.");
  const brand=store.brand;
  const official=isOfficial(c);
  // Only source-discovered candidates enter the production detection workflow.
  if (!official && !sourceCandidateRelevant(c, brand)) {
    const err = new Error("Candidate filtered out: its identity does not sufficiently match the registered brand or a supported profile/app listing.");
    err.code = "IRRELEVANT_CANDIDATE";
    throw err;
  }
  // Generic keywords (e.g. "support", "shop", "official") must not act as a brand identity.
  const { brandIdentityTerms } = require("./detection");
  const brandTerms=brandIdentityTerms(brand);
  let bestName=0, matchedTerm="";
  const candidateNameTokens=words(c.name);
  for(const term of brandTerms){
    const termTokens=words(term);
    const comparisons=[similarity(c.name,term), ...candidateNameTokens.flatMap(a=>termTokens.map(b=>similarity(a,b)))];
    const s=Math.max(0,...comparisons);
    if(s>bestName){bestName=s;matchedTerm=term;}
  }
  const compactName=norm(c.name);
  const brandCompact=norm(brand.name);
  const hasBrandSubstring=!!brandCompact && compactName.includes(brandCompact);
  const addedWords = words(c.name).filter(w=>!words(brand.name).includes(w));
  const spacingVariant = words(c.name).join("")===brandCompact && clean(c.name).toLowerCase()!==clean(brand.name).toLowerCase();
  const typoSimilarity = bestName;
  const brandDescWords=words(`${brand.name} ${brand.description||""} ${(brand.keywords||[]).join(" ")}`);
  const candidateWords=words(c.description);
  const descOverlap=brandDescWords.length?new Set(candidateWords.filter(w=>brandDescWords.includes(w))).size/Math.max(1,new Set(brandDescWords).size):0;
  const officialPublishers=new Set((brand.officialApps||[]).map(a=>norm(a.developer)).filter(Boolean));
  const publisherMismatch=c.type==="app" && !!c.publisher && officialPublishers.size>0 && !officialPublishers.has(norm(c.publisher));
  const riskyLanguage=/verify your account|claim a reward|bonus reward|urgent|password|seed phrase|send us a message|unlock loyalty|account suspended|limited time/i.test(c.description);
  // A brand mentioned only in descriptive text is weak context, not identity evidence.
  const identityText=[c.name,c.handle].join(" ");
  const identityTokens=words(identityText);
  const brandMention=brandTerms.some(t=>containsTokenPhrase(identityTokens,words(t)));
  const signals=[];
  let score=0;
  if(official) signals.push({key:"official_asset",label:"Matches registered official asset",points:0,detail:"This exact handle, URL, package ID, or registered official app identity is allowlisted."});
  if(!official){
    if(spacingVariant){score+=12;signals.push({key:"spacing_variant",label:"Spacing variation",points:12,detail:"Name compacts to the same characters as the registered brand."});}
    else if(typoSimilarity>=0.72){const pts=typoSimilarity>=0.93?30:typoSimilarity>=0.82?23:15;score+=pts;signals.push({key:"name_similarity",label:"Look-alike name detected",points:pts,detail:`Best brand-term similarity ${(typoSimilarity*100).toFixed(0)}% against “${matchedTerm}”.`});}
    if(hasBrandSubstring && addedWords.length && !spacingVariant){const pts=Math.min(18,8+addedWords.length*3);score+=pts;signals.push({key:"added_words",label:"Brand name with added terms",points:pts,detail:`Additional term(s): ${addedWords.slice(0,5).join(", ")}.`});}
    if(c.type==="app" && publisherMismatch && (typoSimilarity>=0.62 || hasBrandSubstring || brandMention)){score+=12;signals.push({key:"publisher_mismatch",label:"Publisher differs from official publisher",points:12,detail:`Publisher “${c.publisher}” differs from the registered official publisher. This is supporting evidence only.`});}
    if(c.type==="app" && descOverlap>=0.15){const pts=Math.min(18,Math.round(descOverlap*45));score+=pts;signals.push({key:"description_overlap",label:"Description overlaps brand profile",points:pts,detail:`Keyword overlap ${(descOverlap*100).toFixed(0)}% against brand profile text.`});}
    if(riskyLanguage){score+=18;signals.push({key:"risky_language",label:"Potentially deceptive language",points:18,detail:"Description contains account-verification, reward, urgency, or credential-related wording."});}
    if(brandMention && !signals.some(s=>s.key==="name_similarity"||s.key==="added_words"||s.key==="spacing_variant")){score+=10;signals.push({key:"brand_mention",label:"Brand mentioned in metadata",points:10,detail:"Brand identifier appears in candidate identity fields."});}
    if(c.indicators.length){signals.push({key:"indicators",label:"External indicators supplied",points:0,detail:`${c.indicators.length} indicator(s) were supplied but are not independently validated, so they do not increase the risk score.`});}
  }
  score=Math.min(100,score);
  const risk=official?"Excluded":score>=75?"Critical":score>=50?"High":score>=25?"Medium":"Low";
  const disposition=official?"Excluded":score>=50?"Investigate":score>=25?"Review":"Low signal";
  const fingerprint=hash([c.type,c.handle.toLowerCase(),c.packageId.toLowerCase(),norm(c.name),c.url.toLowerCase()].join("|"));
  const prior=store.findings.find(f=>f.fingerprint===fingerprint);
  const finding={
    id:prior?.id || `${c.type==="social"?"SOC":"APP"}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    fingerprint,type:c.type,platform:c.platform,name:c.name,handle:c.handle,url:c.url,description:c.description,publisher:c.publisher,packageId:c.packageId,indicators:c.indicators,source:c.source,
    riskScore:score,riskLevel:risk,status:official?"Excluded":prior?.status||"Open",
    disposition,official,signals,explanation:official?"Excluded because it matches a registered official asset.":signals.length?signals.map(s=>s.label).join("; "):"No strong matching signal was detected. Manual review may still be appropriate.",
    lastSeen:now(),
    createdAt:prior?.createdAt||now(),updatedAt:now()
  };
  if(prior) store.findings=store.findings.filter(f=>f.fingerprint!==fingerprint);
  store.findings.unshift(finding);
  return finding;
}

async function serpApiSearch(query) {
  if (!process.env.SERPAPI_API_KEY) return {available:false, reason:"SERPAPI_API_KEY is not configured. Add it to .env to enable social search and Google Play web results.", results:[]};
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine","google"); url.searchParams.set("q",query); url.searchParams.set("api_key",process.env.SERPAPI_API_KEY); url.searchParams.set("num","10");
  const r = await fetch(url, {signal:AbortSignal.timeout(12000)});
  if (!r.ok) throw new Error(`Search provider returned HTTP ${r.status}`);
  const data = await r.json();
  return {available:true, results:(data.organic_results||[]).map(x=>({title:clean(x.title,250),url:clean(x.link,1000),description:clean(x.snippet,1500),source:clean(x.source||"Search provider",100)})).filter(x=>x.url)};
}
const SOCIAL_HOSTS = new Set(["instagram.com", "facebook.com", "m.facebook.com", "x.com", "twitter.com", "tiktok.com", "linkedin.com"]);
function parseSocialProfile(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!SOCIAL_HOSTS.has(host)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    const first = parts[0].toLowerCase();
    const reserved = new Set(["p","reel","reels","stories","explore","accounts","direct","about","developer","terms","privacy","search","hashtag","watch","marketplace","events","groups","home","i","intent","settings","messages","notifications","company","in","pages","people"]);
    if (host === "instagram.com" && (parts.length !== 1 || reserved.has(first))) return null;
    if ((host === "x.com" || host === "twitter.com") && (parts.length !== 1 || reserved.has(first))) return null;
    if (host === "tiktok.com" && (!first.startsWith("@") || parts.length !== 1)) return null;
    if (host === "linkedin.com" && (!(first === "company" || first === "in") || parts.length !== 2)) return null;
    if (host === "facebook.com" || host === "m.facebook.com") {
      if (reserved.has(first) && !["pages","people"].includes(first)) return null;
      if (["pages","people"].includes(first) && parts.length < 2) return null;
      if (!["pages","people"].includes(first) && parts.length !== 1) return null;
    }
    const handle = host === "linkedin.com" ? parts.slice(0,2).join("/") : (host.includes("facebook.com") && ["pages","people"].includes(first) ? parts.slice(0,3).join("/") : first);
    return { host, handle: handle.startsWith("@") ? handle : `@${handle}`, path: u.pathname };
  } catch { return null; }
}
function isGooglePlayListing(url) {
  try { const u = new URL(url); return ["play.google.com", "www.play.google.com"].includes(u.hostname.toLowerCase()) && u.pathname === "/store/apps/details" && !!u.searchParams.get("id"); }
  catch { return false; }
}
function isAppleAppListing(url) {
  try { const u = new URL(url); return u.hostname.toLowerCase() === "apps.apple.com" && /\/app\//i.test(u.pathname); }
  catch { return false; }
}

function sourceCandidateRelevant(candidate, brand) {
  // Candidate identity must match the brand. Description/publisher text is not identity evidence.
  const { sourceCandidateRelevant: checkRelevance } = require("./detection");
  return checkRelevance(candidate, brand);
}

app.post("/api/monitor/search", async (req,res)=>{
  const requestedQuery=clean(req.body?.query || "",150);
  const source=clean(req.body?.source || "all",50).toLowerCase();
  if (!store.brand?.name) return res.status(400).json({error:"Register a brand before starting monitoring."});
  if (! ["all","social","apps"].includes(source)) return res.status(400).json({error:"Source must be all, social, or apps."});
  const registeredTerms = [store.brand.name, ...(store.brand.keywords || []), ...(store.brand.officialApps || []).map(a=>a.name), ...(store.brand.officialSocial || []).map(a=>String(a.handle||"").replace(/^@/,""))].map(norm).filter(Boolean);
  if (requestedQuery && !registeredTerms.includes(norm(requestedQuery))) {
    return res.status(400).json({error:`Search is limited to identifiers registered in the Brand Profile. Add “${requestedQuery}” as a brand keyword or official identifier first.`, code:"IDENTIFIER_NOT_REGISTERED"});
  }
  // Default workflow: use the saved brand identity and its registered identifiers automatically.
  const baseTerms = requestedQuery ? [requestedQuery] : [store.brand.name, ...(store.brand.keywords||[]), ...(store.brand.officialApps||[]).map(a=>a.name), ...(store.brand.officialSocial||[]).map(a=>String(a.handle||"").replace(/^@/,""))];
  const terms = [...new Set(baseTerms.map(x=>clean(x,150).trim()).filter(x=>norm(x).length>=3))].slice(0,5);
  const warnings=[]; const results=[]; const seen=new Set();
  const addResult = (candidate) => {
    const key=canonicalUrl(candidate.url) || `${candidate.type}:${norm(candidate.name)}:${norm(candidate.publisher)}`;
    if (!key || seen.has(key)) return;
    seen.add(key); results.push(candidate);
  };
  try {
    if (source === "social" || source === "all") {
      const sites=["instagram.com","facebook.com","x.com","tiktok.com","linkedin.com"];
      if (!process.env.SERPAPI_API_KEY) warnings.push("Social discovery needs SERPAPI_API_KEY in .env. No live social public-web search was performed.");
      else {
        for (const term of terms) {
          try {
            const sr=await serpApiSearch(`(${sites.map(s=>`site:${s}`).join(" OR ")}) "${term.replace(/"/g,"")}"`);
            for(const x of sr.results) {
              const profile = parseSocialProfile(x.url);
              if (!profile) continue; // Never mislabel ordinary websites/search pages as social profiles.
              const title = clean(x.title || "", 250);
              addResult({type:"social",platform:profile.host,name:title || profile.handle,url:x.url,handle:profile.handle,description:x.description,publisher:"",source:"SerpAPI public-web discovery"});
            }
          } catch(e) { warnings.push(`Social search for “${term}” failed: ${e.message}. Other identifiers will still be checked.`); }
        }
      }
    }
    if (source === "apps" || source === "all") {
      for (const term of terms) {
        const appleUrl=new URL("https://itunes.apple.com/search"); appleUrl.searchParams.set("term",term); appleUrl.searchParams.set("entity","software"); appleUrl.searchParams.set("limit","10");
        try { const ar=await fetch(appleUrl,{signal:AbortSignal.timeout(10000)}); if(!ar.ok)throw new Error(`Apple Search API HTTP ${ar.status}`); const ad=await ar.json(); for(const x of (ad.results||[])) { const listingUrl=clean(x.trackViewUrl,1000); if (!isAppleAppListing(listingUrl)) continue; addResult({type:"app",platform:"Apple App Store",name:clean(x.trackName,200),url:listingUrl,description:clean(x.description,2000),publisher:clean(x.sellerName,200),packageId:clean(x.bundleId,200),source:"Apple Search API"}); } }
        catch(e){warnings.push(`Apple App Store search for “${term}” failed: ${e.message}`);}
        if (process.env.SERPAPI_API_KEY) {
          try { const gp=await serpApiSearch(`site:play.google.com/store/apps/details "${term.replace(/"/g,"")}"`); for(const x of gp.results) { if (!isGooglePlayListing(x.url)) continue; let packageId=""; try { packageId=new URL(x.url).searchParams.get("id")||""; } catch {} addResult({type:"app",platform:"Google Play",name:x.title,url:x.url,description:x.description,publisher:"",packageId,source:"SerpAPI Google Play public-web discovery"}); } }
          catch(e){warnings.push(`Google Play search for “${term}” failed: ${e.message}`);}
        }
      }
      if (!process.env.SERPAPI_API_KEY) warnings.push("Google Play public-web discovery needs SERPAPI_API_KEY. Apple App Store search is attempted independently.");
    }
    const relevant = results.filter(c => sourceCandidateRelevant(c, store.brand));
    const analyzed=[];
    for(const c of relevant.slice(0,100)) { try { analyzed.push(analyzeCandidate(c)); } catch {} }
    if (results.length && !relevant.length) warnings.push("Sources returned results, but none matched the registered brand strongly enough to score. This is not proof that no impersonation exists.");
    if (relevant.length < results.length) warnings.push(`${results.length - relevant.length} weakly related results were filtered out before risk scoring.`);
    store.scans.unshift({id:crypto.randomUUID(),time:now(),count:analyzed.length,flagged:analyzed.filter(f=>f.riskScore>=25&&!f.official).length,excluded:analyzed.filter(f=>f.official).length,source:`Live source discovery (${source})`,warnings:warnings.length});
    store.scans=store.scans.slice(0,200);
    await persist();
    res.json({query:requestedQuery||store.brand.name,identifiersSearched:terms,source,rawResultCount:results.length,resultCount:relevant.length,analyzedCount:analyzed.length,results:analyzed,warnings,providers:{social:!!process.env.SERPAPI_API_KEY,appleAppStore:true,googlePlay:!!process.env.SERPAPI_API_KEY},notice:"Automatic discovery checks supported public sources using registered brand identifiers. It is not a complete crawl of every social network; findings require review and source coverage depends on provider access."});
  } catch(e) { res.status(502).json({error:`Source search failed: ${e.message}`,warnings}); }
});

app.get("/api/health",(_req,res)=>res.json({ok:true,service:"Trinetra API",persistence,sourceMode:"registered-brand source discovery",timestamp:now(),integrations:{social:process.env.SERPAPI_API_KEY?"Public web search enabled via SerpAPI":"Requires SERPAPI_API_KEY for public-web discovery",appStores:process.env.SERPAPI_API_KEY?"Apple Search API + Google Play web search":"Apple Search API available; Google Play web search requires SERPAPI_API_KEY"}}));
app.get("/api/brand",(_req,res)=>res.json(store.brand));
// Registering a different company starts a clean workspace so no previous brand's
// demo candidates or findings leak into the new brand view.
app.post("/api/brand/register",async(req,res)=>{
  const b=req.body||{};
  if(!clean(b.name,200)) return res.status(400).json({error:"Company / brand name is required."});
  const list=(v)=>Array.isArray(v)?v:[];
  store.brand={
    name:clean(b.name,200), logoUrl:clean(b.logoUrl,1000),
    website:clean(b.website,1000), description:clean(b.description,1000),
    keywords:list(b.keywords).map(x=>clean(x,100)).filter(Boolean),
    officialSocial:list(b.officialSocial).map(a=>({platform:clean(a.platform,100),handle:clean(a.handle,150),url:clean(a.url,1000)})),
    officialApps:list(b.officialApps).map(a=>({name:clean(a.name,200),developer:clean(a.developer,200),packageId:clean(a.packageId,200),store:clean(a.store,100),url:clean(a.url,1000),description:clean(a.description,1000)})),
    createdAt:now(),updatedAt:now()
  };
  store.candidates=[]; store.findings=[];  store.scans=[];
  await persist();
  res.status(201).json({brand:store.brand,clearedPreviousWorkspace:true});
});
app.put("/api/brand",async(req,res)=>{
  const b=req.body||{};
  if(!clean(b.name,200))return res.status(400).json({error:"Brand name is required."});
  const parseList=(v)=>Array.isArray(v)?v:[];
  store.brand={...store.brand,name:clean(b.name,200),logoUrl:clean(b.logoUrl,1000),website:clean(b.website,1000),description:clean(b.description,1000),keywords:parseList(b.keywords).map(x=>clean(x,100)).filter(Boolean),officialSocial:parseList(b.officialSocial).map(a=>({platform:clean(a.platform,100),handle:clean(a.handle,150),url:clean(a.url,1000)})),officialApps:parseList(b.officialApps).map(a=>({name:clean(a.name,200),developer:clean(a.developer,200),packageId:clean(a.packageId,200),store:clean(a.store,100),url:clean(a.url,1000),description:clean(a.description,1000)})),updatedAt:now()};
  await persist();res.json(store.brand);
});
app.get("/api/findings",(req,res)=>{
  let list=store.findings;
  if(req.query.type&&req.query.type!=="all")list=list.filter(f=>f.type===req.query.type);
  if(req.query.status&&req.query.status!=="all")list=list.filter(f=>f.status.toLowerCase()===String(req.query.status).toLowerCase());
  if(req.query.q){const q=String(req.query.q).toLowerCase();list=list.filter(f=>[f.name,f.handle,f.platform,f.id,f.publisher,f.description].join(" ").toLowerCase().includes(q));}
  res.json(list);
});
app.patch("/api/findings/:id",async(req,res)=>{
  const f=store.findings.find(x=>x.id===req.params.id);
  if(!f)return res.status(404).json({error:"Finding not found."});
  const allowed=["Open","Under Review","Resolved","Excluded"];
  if(!allowed.includes(req.body?.status))return res.status(400).json({error:"Invalid status."});
  f.status=req.body.status;f.updatedAt=now();
  await persist();res.json(f);
});
app.get("/api/scans",(_req,res)=>res.json(store.scans));
app.use("/api/*",(req,res)=>res.status(404).json({error:`API route not found: ${req.method} ${req.path}`}));
if(process.env.NODE_ENV==="production"){
  const dist=path.join(ROOT,"client","dist");
  app.use(express.static(dist));
  app.get("*",(req,res)=>res.sendFile(path.join(dist,"index.html")));
}
initStore().then(async()=>{
  app.listen(PORT,()=>console.log(`Trinetra running on port ${PORT} (${persistence})`));
}).catch(e=>{console.error("Startup failed:",e);process.exit(1);});
