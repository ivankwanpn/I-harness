/**
 * Public surface of the commit-log core.
 *
 * The store/facade (Plan 2) is the first consumer, so this module deliberately
 * exports nothing yet: the reachability gate treats an unconsumed export as
 * dead surface. Plan 2 replaces this file with the store's exports as it wires
 * the first real consumer.
 */
export {}
