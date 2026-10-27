export type PulseRecord={id:string;key:string;source:string;refs:string[];title:string;severity:string;evidence:string;owners:string[];at:string;updatedAt:string;inferred:boolean;status:string;version:number;revision:number;events:{revision:number;at:string;kind:string;actor?:string}[]};
export function derivePulse(input:unknown,now?:number):unknown[];
export function validPulse(input:unknown):PulseRecord;
