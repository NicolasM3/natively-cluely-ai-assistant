/**
 * TLS BOOT GATE — disable Node.js certificate validation for outbound HTTPS.
 *
 * Required on machines behind SSL-inspection proxies (e.g. Netskope) whose root
 * CA is not in Node's trust store. Without this, axios / @google/genai calls
 * to provider APIs fail with "self signed certificate in certificate chain".
 *
 * Must be the FIRST import in main.ts so esbuild runs init_tlsGate() before
 * any module loads node:https / axios / @google/genai.
 *
 * SECURITY: this disables TLS verification for ALL Node HTTPS in the main
 * process. Do not enable in environments where MITM resistance matters.
 */
(() => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
})();
