/** Lightweight profile/CV question detector for renderer preflight (RAG skip). */
export function looksLikeProfileQuestion(text) {
  const q = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(formacao|formacoes|tecnolog|habilidad|competencia|experiencia|graduacao|curriculo|background|resume|cv|skills?|education|degree|studied|worked with|your role|sua|seu|minha|meu|quais sao|qual e a)\b/.test(q);
}
