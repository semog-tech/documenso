type RemarkCandidate = {
  recipientId: number;
  type: string;
  fieldMeta: unknown;
};
type RecipientRemarkState = { recipientId: number; signingStatus: string; envelopeStatus: string };
export const findRecipientRemark = <T extends RemarkCandidate>(
  fields: T[],
  state: RecipientRemarkState,
): T | undefined => {
  if (state.signingStatus === 'SIGNED' || state.envelopeStatus !== 'PENDING') {
    return undefined;
  }
  return fields.find((field) => {
    const meta = field.fieldMeta;
    return (
      field.recipientId === state.recipientId &&
      field.type === 'TEXT' &&
      typeof meta === 'object' &&
      meta !== null &&
      'label' in meta &&
      meta.label === 'Comentário / ressalvas (opcional)' &&
      'required' in meta &&
      meta.required === false &&
      (!('readOnly' in meta) || meta.readOnly !== true)
    );
  });
};
export const editRecipientRemark = async (options: {
  initialText: string;
  open: (initialText: string) => Promise<string | null>;
  save: (text: string) => Promise<void>;
  isActive: () => boolean;
}): Promise<void> => {
  const text = await options.open(options.initialText);
  if (text === null || !options.isActive()) {
    return;
  }
  await options.save(text);
};
