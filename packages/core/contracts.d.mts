export interface ContractFields {side:'expected'|'implemented';document:any;intentionId?:string}
export interface ContractRecord {schemaVersion:1;id:string;projectId:string;contextId?:string;participantId:string;displayName:string;createdAt:string;updatedAt:string;version:number;revision:number;contentVersion:number;status:'published'|'approved';authorActive:boolean;fields:ContractFields;history:{contentVersion:number;actorId:string;at:string;fields:ContractFields}[];reviews:{kind:string;participantId:string;displayName:string;text:string;contentVersion:number;at:string;active:boolean}[]}
export function validateContractDocument(input:unknown):any;
export function contractFields(input:unknown):ContractFields;
export function validContract(input:unknown):ContractRecord;

export function normalizeContractDocument(input:unknown):any;
