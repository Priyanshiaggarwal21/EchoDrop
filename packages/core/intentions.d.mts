export interface Intention { schemaVersion:1; id:string;projectId:string;contextId?:string;participantId:string;displayName:string;description:string;paths:string[];modules:string[];hours:number;status:string;version:number;revision:number;createdAt:string;updatedAt:string;expiresAt:string;notes:{kind:string;text:string;participantId:string;displayName:string;at:string}[] }
export function intentPath(value:string):string;
export function intentFields(value:unknown):{description:string;paths:string[];modules:string[];hours:number};
export function validIntent(value:unknown):Intention;
export function intentCollisions(candidate:{id?:string;paths:string[];modules:string[]},records:Intention[],principalId:string,now?:number):{item:Intention;paths:string[];modules:string[]}[];
