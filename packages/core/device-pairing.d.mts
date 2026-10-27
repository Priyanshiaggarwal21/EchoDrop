export interface DeviceInvitation {v:1;id:string;projectId:string;contextId?:string;host:string;port:number;fingerprint:string;recipient:string;expiresAt:number}
export function parseDeviceInvitation(text:string):DeviceInvitation;
export function deviceInvitation(value:DeviceInvitation):string;
