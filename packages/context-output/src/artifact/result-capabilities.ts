// Constructor association only. Copying a service DTO cannot advertise the
// newly required original-writer refusal/cleanup contract.
const originals=new WeakSet<object>()
export function associateManagedResultRefusal(service:object){originals.add(service)}
export function supportsManagedResultRefusal(service:object):boolean{return originals.has(service)}
