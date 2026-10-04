import type { ApiConfig } from '../config';
import { Logger } from '../logger';

export interface OutboxMail {
  to: string;
  subject: string;
  body: string;
  link?: string;
  sentAt: string;
}

const MAX = 50;

/**
 * Stand-in for real email delivery. Mails are kept in memory and, outside production, readable at `GET /dev/outbox`.
 * Links are never logged in production (they grant access).
 */
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly outbox: OutboxMail[] = [];

  constructor(private readonly config: ApiConfig) {}

  send(mail: Omit<OutboxMail, 'sentAt'>): void {
    this.outbox.unshift({ ...mail, sentAt: new Date().toISOString() });
    this.outbox.length = Math.min(this.outbox.length, MAX);
    this.logger.log(JSON.stringify({ event: 'mail.queued', subject: mail.subject, ...(this.config.production ? {} : { to: mail.to, link: mail.link }) }));
  }

  list(): OutboxMail[] {
    return [...this.outbox];
  }
}
