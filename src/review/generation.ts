/**
 * Latest-wins guard for overlapping reviews.
 *
 * A review that takes a while to fetch and order can finish after a newer one has
 * started. Each run takes a ticket; only the run holding the newest ticket is allowed
 * to publish its result, so a slow older review cannot overwrite a fresh one.
 */
export class Generation {
  private value = 0;

  /** Start a new run and return its ticket, retiring every earlier one. */
  next(): number {
    this.value += 1;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  /** True while no newer run has started since this ticket was taken. */
  isCurrent(ticket: number): boolean {
    return ticket === this.value;
  }
}
