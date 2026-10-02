/** A fake browser lifecycle owner with the real one's contention rules: it runs one mutation at a time and refuses
 * anything that arrives meanwhile with 409 controller_busy; a profile with a live lease is refused with 409
 * profile_in_use. Refusals carry `{"error": code}` and Retry-After: 30, as the real owner's do. */
export class FakeLifecycleOwner {
  readonly base = 'http://lifecycle.example.test';
  /** Every refusal the owner answered, in order. */
  readonly refusals: string[] = [];
  /** Every request it received: method, profile (for POST) and when. */
  readonly requests: { method: string; profile?: string; at: number }[] = [];
  /** Grants in order, by profile. */
  readonly grants: string[] = [];
  /** The most live leases ever held on one profile at once. */
  maxPerProfile = 0;
  /** Refuse the next N mutations with controller_busy, as if another client or the owner's sweep held the mutex. */
  externalBusy = 0;
  /** Lifetime of a granted lease. */
  ttlMs = 5 * 60_000;
  private mutating = false;
  private next = 0;
  private readonly leases = new Map<string, { profile: string; purpose: string; expiresAt: number }>();

  constructor(private readonly workMs = 5) {}

  handles(url: string): boolean { return url.startsWith(this.base); }

  /** Live leases on the profile now. */
  live(profile: string): number {
    return [...this.leases.values()].filter((lease) => lease.profile === profile && lease.expiresAt > Date.now()).length;
  }

  get liveTotal(): number { return [...this.leases.values()].filter((lease) => lease.expiresAt > Date.now()).length; }

  async handle(url: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? 'GET';
    const path = url.slice(this.base.length);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as { profile_id?: string; purpose?: string } : {};
    this.requests.push({ method, profile: body.profile_id, at: Date.now() });
    if (this.externalBusy > 0) { this.externalBusy -= 1; return this.refuse('controller_busy'); }
    if (this.mutating) return this.refuse('controller_busy');
    this.mutating = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, this.workMs));
      if (method === 'POST' && path === '/leases') {
        const profile = String(body.profile_id);
        if (this.live(profile) > 0) return this.refuse('profile_in_use');
        const id = `lease-${++this.next}`;
        const expiresAt = Date.now() + this.ttlMs;
        this.leases.set(id, { profile, purpose: String(body.purpose), expiresAt });
        this.grants.push(profile);
        this.maxPerProfile = Math.max(this.maxPerProfile, this.live(profile));
        return Response.json({ lease_id: id, profile_id: profile, purpose: body.purpose, expires_at: expiresAt / 1000 }, { status: 201 });
      }
      const id = path.match(/^\/leases\/([\w-]+)$/)?.[1];
      if (id && method === 'DELETE') { this.leases.delete(id); return Response.json({ released: true, lease_id: id }); }
      if (id && method === 'PATCH') {
        const lease = this.leases.get(id);
        if (!lease || lease.expiresAt <= Date.now()) return Response.json({ error: 'lease_expired' }, { status: 410 });
        lease.expiresAt = Date.now() + this.ttlMs;
        return Response.json({ lease_id: id, expires_at: lease.expiresAt / 1000 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    } finally {
      this.mutating = false;
    }
  }

  private refuse(code: string): Response {
    this.refusals.push(code);
    return Response.json({ error: code }, { status: 409, headers: { 'Retry-After': '30' } });
  }
}
