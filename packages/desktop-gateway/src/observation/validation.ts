export function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw Error('Invalid surface request');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key])))
        throw Error('Invalid surface fields');
    return value as Record<string, unknown>;
}
export function opaque(value: unknown): string { if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 128)
    throw Error('Invalid surface identity'); return value; }
export function session(value: unknown): string { if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 256)
    throw Error('Invalid surface session'); return value; }
export function integer(value: unknown, min: number, max: number, fallback: number): number { if (value === undefined)
    return fallback; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw Error('Invalid surface page'); return value; }
