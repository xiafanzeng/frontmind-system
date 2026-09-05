/** Returns the exact navigation bridge installed before customer application
 * code in private previews and in the pre-preview Chromium gate. Keeping one
 * source prevents the QA harness from validating a different pathname model
 * than the artifact proxy serves. */
export function previewNavigationBridgeSource(previewPrefix: string) {
  const serializedPrefix = JSON.stringify(previewPrefix)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `(()=>{"use strict";const p=${serializedPrefix};const r=u=>typeof u==="string"&&u.startsWith("/")&&!u.startsWith("//")&&!u.startsWith(p)?p+u.slice(1):u;const c=()=>{const u=location.pathname;return u.startsWith(p)?"/"+u.slice(p.length):u};Object.defineProperty(window,"canonicalSitePathname",{configurable:false,enumerable:false,writable:false,value:c});Object.defineProperty(window,"__FRONTMIND_SITEOPS_PREVIEW__",{configurable:false,enumerable:false,writable:false,value:Object.freeze({canonicalSitePathname:c,previewPrefix:p,toPreviewUrl:r})});for(const n of ["pushState","replaceState"]){const o=history[n].bind(history);history[n]=(s,t,u)=>o(s,t,r(u))}document.addEventListener("click",e=>{if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;const t=e.target instanceof Element?e.target.closest("a[href]"):null;if(!t||t.hasAttribute("download")&&t.getAttribute("download")!==null||t.target&&t.target!=="_self")return;const u=t.getAttribute("href");const n=r(u);if(n!==u)t.setAttribute("href",n)},true)})();`;
}
