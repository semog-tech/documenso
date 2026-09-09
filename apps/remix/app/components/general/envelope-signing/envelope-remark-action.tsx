import { useCurrentEnvelopeRender } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { PDF_VIEWER_CONTENT_SELECTOR } from '@documenso/lib/constants/pdf-viewer';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { ZTextFieldMeta } from '@documenso/lib/types/field-meta';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { MessageSquarePlusIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SignFieldTextDialog } from '~/components/dialogs/sign-field-text-dialog';
import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { editRecipientRemark, findRecipientRemark } from '~/utils/recipient-remark';
import { waitForRemarkPage } from '~/utils/remark-page';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';

export const EnvelopeRemarkAction = () => {
  const { recipient, recipientFields, envelope, signField } = useRequiredEnvelopeSigningContext();
  const { currentEnvelopeItem, setCurrentEnvelopeItem } = useCurrentEnvelopeRender();
  const { onFieldSigned } = useEmbedSigningContext() || {};
  const { toast } = useToast();
  const [isBusy, setIsBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const field = findRecipientRemark(recipientFields, {
    recipientId: recipient.id,
    signingStatus: recipient.signingStatus,
    envelopeStatus: envelope.status,
  });
  const latest = useRef({ field, currentItemId: currentEnvelopeItem?.id });
  latest.current = { field, currentItemId: currentEnvelopeItem?.id };
  useEffect(() => () => controller.current?.abort(), []);
  if (!field) {
    return null;
  }
  const openRemark = async () => {
    if (controller.current) {
      return;
    }
    const operation = new AbortController();
    controller.current = operation;
    setIsBusy(true);
    try {
      const meta = ZTextFieldMeta.parse(field.fieldMeta);
      const previousContent =
        field.envelopeItemId !== currentEnvelopeItem?.id ? document.querySelector(PDF_VIEWER_CONTENT_SELECTOR) : null;
      setCurrentEnvelopeItem(field.envelopeItemId);
      const page = await waitForRemarkPage({
        pageNumber: field.page,
        signal: operation.signal,
        previousContent,
        isCurrentItem: () => latest.current.currentItemId === field.envelopeItemId,
      });
      if (operation.signal.aborted || latest.current.field?.id !== field.id) {
        return;
      }
      if (!page) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Não foi possível carregar a página da ressalva. Tente novamente.',
        });
      }
      await editRecipientRemark({
        initialText: field.customText,
        open: (initialText) =>
          SignFieldTextDialog.call({
            fieldMeta: meta,
            initialText,
            copy: { description: t`O preenchimento é opcional.`, confirmLabel: t`Salvar ressalva` },
          }),
        isActive: () => !operation.signal.aborted && latest.current.field?.id === field.id,
        save: async (text) => {
          const result = await signField(field.id, { type: 'TEXT', value: text });
          if (result.inserted) {
            onFieldSigned?.({ fieldId: field.id, value: JSON.stringify(text), isBase64: false });
          }
        },
      });
    } catch (caught) {
      const error = AppError.parseError(caught);
      if (!operation.signal.aborted) {
        toast({
          title: t`Não foi possível salvar a ressalva`,
          description:
            error.code === AppErrorCode.NOT_FOUND
              ? t`Não foi possível carregar a página da ressalva. Tente novamente.`
              : t`Não foi possível confirmar a gravação. Confira o campo antes de tentar novamente.`,
          variant: 'destructive',
        });
      }
    } finally {
      controller.current = null;
      if (!operation.signal.aborted) {
        setIsBusy(false);
      }
    }
  };
  return (
    <div className="order-last flex w-full items-center justify-end gap-2 pt-2 lg:order-none lg:ml-auto lg:w-auto lg:pt-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isBusy}
        onClick={() => {
          void openRemark();
        }}
      >
        <MessageSquarePlusIcon className="mr-2 h-4 w-4" />
        {isBusy ? (
          <Trans>Carregando ressalva...</Trans>
        ) : field.customText ? (
          <Trans>Editar ressalva</Trans>
        ) : (
          <Trans>Adicionar ressalva</Trans>
        )}
      </Button>
      <span className="text-muted-foreground text-xs">
        <Trans>Opcional</Trans>
      </span>
    </div>
  );
};
