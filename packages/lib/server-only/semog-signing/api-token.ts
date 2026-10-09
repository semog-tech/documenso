import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import type { SemogActor } from './service';

/** Mirrors native get-api-token-by-token: SHA512, team binding, expiry and disabled owner/user checks. */
export const createSemogApiTokenAuthenticator =
  (client: Pick<PrismaClient, 'apiToken'>) =>
  async (token: string): Promise<SemogActor | null> => {
    if (!/^api_[a-z0-9]{16}$/.test(token)) {
      return null;
    }
    const entry = await client.apiToken.findUnique({
      where: { token: createHash('sha512').update(token).digest('hex') },
      include: {
        user: { select: { id: true, disabled: true } },
        team: { include: { organisation: { include: { owner: { select: { id: true, disabled: true } } } } } },
      },
    });
    if (
      !entry ||
      entry.algorithm !== 'SHA512' ||
      (entry.expires !== null && entry.expires <= new Date()) ||
      entry.user?.disabled ||
      entry.team.organisation.owner.disabled
    ) {
      return null;
    }
    return { teamId: entry.teamId, userId: entry.user?.id ?? entry.team.organisation.owner.id };
  };
