const GENERIC_BRAND_TERMS = new Set(["official","support","help","login","app","apps","shop","store","secure","security","service","services","online","website","company","group","global","india","team","customer","care","account","portal","home","page","site","the","inc","ltd","limited"]);
const clean = (v, max=500) => String(v ?? "").trim().slice(0,max);
const norm = (s) => clean(s,300).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const words = (s) => clean(s,1000).toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).filter(Boolean);
const isGenericBrandTerm = (term) => {
  const tokens = words(term);
  return !tokens.length || tokens.every(token => GENERIC_BRAND_TERMS.has(token)) || norm(term).length < 4;
};
const containsTokenPhrase = (haystack, needle) => {
  if (!haystack.length || !needle.length || needle.length > haystack.length) return false;
  for (let i=0; i<=haystack.length-needle.length; i++) {
    if (needle.every((token,j) => haystack[i+j] === token)) return true;
  }
  return false;
};
function levenshtein(a,b) {
  if (a===b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++) {
    const cur=[i];
    for(let j=1;j<=b.length;j++) cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev=cur;
  }
  return prev[b.length];
}
const similarity = (a,b) => {
  const x=norm(a), y=norm(b);
  if(!x||!y) return 0;
  if(x===y) return 1;
  return Math.max(0,1-levenshtein(x,y)/Math.max(x.length,y.length));
};
function validSocialProfileUrl(value) {
  if (!value) return true; // Handle-only manual tests are allowed.
  try {
    const u=new URL(value);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return false;
    const host=u.hostname.toLowerCase().replace(/^www\./, "");
    const parts=u.pathname.split("/").filter(Boolean);
    const reserved=new Set(["p","reel","reels","explore","stories","share","watch","search","settings","messages","notifications","intent","home","groups"]);
    if (["instagram.com","x.com","twitter.com"].includes(host)) return parts.length===1 && !reserved.has(parts[0].toLowerCase());
    if (["facebook.com","m.facebook.com"].includes(host)) return parts.length===1 && !reserved.has(parts[0].toLowerCase()) || ["pages","people"].includes((parts[0]||"").toLowerCase()) && parts.length>=2;
    if (host==="tiktok.com") return parts.length===1 && parts[0].startsWith("@");
    if (host==="linkedin.com") return parts.length===2 && ["company","in"].includes(parts[0].toLowerCase());
    return false;
  } catch { return false; }
}
function validAppListingUrl(value) {
  if (!value) return true; // Package-ID-only manual tests are allowed.
  try {
    const u=new URL(value), host=u.hostname.toLowerCase();
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return false;
    return (host==="play.google.com" && u.pathname==="/store/apps/details" && !!u.searchParams.get("id")) || (host==="apps.apple.com" && /\/app\//i.test(u.pathname));
  } catch { return false; }
}
function brandIdentityTerms(brand) {
  if (!brand?.name) return [];
  const candidates = [
    // The registered brand name is the primary identity. Short (3-character)
    // names are allowed for exact phrase matching only; fuzzy matching below
    // is reserved for terms of at least five characters.
    brand.name,
    ...(brand.officialApps || []).map(a => a.name),
    ...(brand.officialSocial || []).map(a => String(a.handle || "").replace(/^@/, ""))
  ];
  const seen = new Set();
  return candidates.map(x => clean(x, 200).trim()).filter(term => {
    const key = norm(term);
    const tokens = words(term);
    const genericOnly = !tokens.length || tokens.every(token => GENERIC_BRAND_TERMS.has(token));
    if (!key || key.length < 3 || genericOnly || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function sourceCandidateRelevant(candidate, brand) {
  if (!brand?.name) return false;
  if (candidate.type === "social" && !validSocialProfileUrl(candidate.url)) return false;
  if (candidate.type === "app" && !validAppListingUrl(candidate.url)) return false;

  // Search keywords help discovery, but are NOT proof of identity. Otherwise a
  // broad keyword such as "brand impersonation" can make unrelated profiles pass.
  const primaryTerms = brandIdentityTerms(brand);
  if (!primaryTerms.length) return false;
  let urlPath = "";
  try {
    const u = new URL(candidate.url || "");
    urlPath = decodeURIComponent(u.pathname || "").replace(/\.[a-z0-9]{2,5}$/i, " ");
  } catch {}
  const identityValues = [candidate.name, candidate.handle, urlPath, candidate.packageId]
    .map(x => clean(x, 500)).filter(Boolean);
  return primaryTerms.some(term => {
    const termTokens = words(term);
    if (!termTokens.length) return false;
    const compactTerm = norm(term);
    return identityValues.some(value => {
      const identityTokens = words(value);
      // Exact token phrase is preferred.
      if (containsTokenPhrase(identityTokens, termTokens)) return true;
      // Some real handles/package slugs concatenate brand + suffix without separators.
      // Permit a clear brand prefix/suffix only when the remainder is meaningful,
      // and never use this for short brand identifiers.
      if (compactTerm.length >= 6) {
        const compactValue = norm(value);
        if (compactValue.length > compactTerm.length &&
            (compactValue.startsWith(compactTerm) || compactValue.endsWith(compactTerm))) {
          const remainder = compactValue.startsWith(compactTerm)
            ? compactValue.slice(compactTerm.length) : compactValue.slice(0, -compactTerm.length);
          if (remainder.length >= 3) return true;
        }
      }
      // Typo tolerance is limited to long identity tokens and a relatively high
      // similarity threshold, reducing matches from generic words and short brands.
      if (termTokens.length === 1 && termTokens[0].length >= 5) {
        return identityTokens.some(token => token.length >= 5 && similarity(token, termTokens[0]) >= 0.84);
      }
      return false;
    });
  });
}

module.exports={sourceCandidateRelevant,similarity,isGenericBrandTerm,brandIdentityTerms,validSocialProfileUrl,validAppListingUrl};
