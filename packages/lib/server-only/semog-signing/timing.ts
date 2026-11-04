/** Bridge stages measured for the host log. Carries no person, token or document data. */
export type SemogStage =
  | 'storage.s3.put'
  | 'storage.s3.head'
  | 'storage.s3.read'
  | 'storage.s3.hash'
  | 'storage.s3.checksum'
  | 'storage.s3.confirm.head-checksum'
  | 'storage.s3.confirm.readback'
  | 'draft.total'
  | 'draft.authenticate'
  | 'draft.body'
  | 'draft.parse.json'
  | 'draft.parse.multipart'
  | 'draft.validate'
  | 'draft.validate.schema'
  | 'draft.decode.base64'
  | 'draft.hash'
  | 'draft.pdf-load'
  | 'draft.request-hash'
  | 'draft.storage'
  | 'draft.storage.write'
  | 'draft.storage.read'
  | 'draft.storage.head'
  | 'draft.transaction'
  | 'draft.actor'
  | 'draft.lock'
  | 'draft.replay'
  | 'draft.native'
  | 'draft.document'
  | 'draft.envelope-items'
  | 'draft.recipients-fields'
  | 'draft.audit'
  | 'draft.receipt'
  | 'draft.confirm'
  | 'draft.response'
  | 'seal.delivery'
  | 'seal.actor'
  | 'seal.receipt-check'
  | 'seal.total'
  | 'seal.source'
  | 'seal.read'
  | 'seal.preread'
  | 'seal.lock'
  | 'seal.envelope'
  | 'seal.audit'
  | 'seal.original-load'
  | 'seal.render'
  | 'seal.pdf-load'
  | 'seal.decorate'
  | 'seal.pdf-save'
  | 'seal.normalize'
  | 'seal.sign'
  | 'seal.signer'
  | 'seal.storage'
  | 'seal.document-write'
  | 'seal.receipt-write'
  | 'seal.complete'
  | 'seal.transaction'
  | 'seal.confirm'
  | 'seal.notify'
  | 'get.metadata'
  | 'pdf.metadata'
  | 'get.transaction'
  | 'pdf.source'
  | 'pdf.read'
  | 'pdf.hash'
  | 'pdf.transaction'
  | 'manifestation'
  | 'reserve.read'
  | 'reserve.snapshot'
  | 'execute.read'
  | 'execute.pdf'
  | 'execute.transaction';
export type SemogStageTiming = {
  stage: SemogStage;
  ms: number;
  ok: boolean;
  bytes?: number;
  attempts?: number;
};
export type SemogStageObserver = (timing: SemogStageTiming) => void;
type Details = Pick<SemogStageTiming, 'bytes' | 'attempts'>;

/** Reports the stage either way and rethrows untouched: measuring never changes the outcome. */
export const timeSemogStage = async <T>(
  observe: SemogStageObserver | undefined,
  stage: SemogStage,
  run: () => T | Promise<T>,
  details?: (value: T) => Details,
): Promise<T> => {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const report = (ok: boolean, value?: T) => {
    try {
      observe?.({ stage, ms: elapsed(), ok, ...(ok && value !== undefined ? details?.(value) : {}) });
    } catch {
      // Telemetry is best effort: observer/formatting failures must not change a durable operation's result.
      return;
    }
  };
  try {
    const value = await run();
    report(true, value);
    return value;
  } catch (error) {
    report(false);
    throw error;
  }
};
