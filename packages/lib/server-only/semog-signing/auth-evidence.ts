import { z } from 'zod';

export const ZSemogAuthenticationEvidence = z.object({
  canal: z.enum(['email', 'whatsapp']),
  metodoAutenticacao: z.enum(['link', 'codigo']).optional(),
});
export type SemogAuthenticationEvidence = z.infer<typeof ZSemogAuthenticationEvidence>;

/** Legacy bridge requests required a code; omission keeps their durable request hash intact. */
export const semogAuthenticationMethod = (evidence: SemogAuthenticationEvidence) =>
  evidence.metodoAutenticacao ?? 'codigo';

export const semogAuthenticationLabel = (evidence: SemogAuthenticationEvidence) => {
  const channel = evidence.canal === 'whatsapp' ? 'WhatsApp' : 'e-mail';
  return semogAuthenticationMethod(evidence) === 'link' ? `Link enviado por ${channel}` : `Código por ${channel}`;
};
