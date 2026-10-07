import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

@Injectable()
export class StatsSyncGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.STATS_SYNC_TOKEN;
    if (!expected) throw new ServiceUnavailableException('Stats update is not configured on this server.');

    const authorization = context.switchToHttp().getRequest().headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('Invalid update key.');
    }
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(authorization.slice(7)), digest(expected))) {
      throw new UnauthorizedException('Invalid update key.');
    }
    return true;
  }
}
