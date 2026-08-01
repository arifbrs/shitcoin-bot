/** Synchronous reservation book closing the await-gap in actor-cluster exposure checks. */
export class ExposureReservationBook {
  private seq = 0;
  private readonly rows = new Map<string, string[]>();

  overlappingCount(clusterIds: string[]): number {
    const wanted = new Set(clusterIds.filter(Boolean));
    if (!wanted.size) return 0;
    let count = 0;
    for (const ids of this.rows.values()) {
      if (ids.some((id) => wanted.has(id))) count++;
    }
    return count;
  }

  reserve(clusterIds: string[]): string {
    const token = `cluster-reservation-${this.seq++}`;
    this.rows.set(token, [...new Set(clusterIds.filter(Boolean))]);
    return token;
  }

  release(token: string): void {
    this.rows.delete(token);
  }

  size(): number {
    return this.rows.size;
  }
}
