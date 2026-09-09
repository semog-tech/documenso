import { Trans } from '@lingui/react/macro';
import { Button } from '../button';

export const SignatureFontStatus = ({ status, retry }: { status: string; retry: () => void }) => (
  <div
    className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground text-sm"
    role="status"
  >
    {status === 'error' ? (
      <>
        <Trans>Não foi possível carregar a fonte da assinatura.</Trans>
        <p>
          <Trans>Ao recarregar, alterações ainda não salvas serão perdidas.</Trans>
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={retry}>
          <Trans>Recarregar página</Trans>
        </Button>
      </>
    ) : (
      <Trans>Carregando fonte da assinatura…</Trans>
    )}
  </div>
);
