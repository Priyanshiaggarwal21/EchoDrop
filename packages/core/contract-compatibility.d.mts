export interface CompatibilityIssue {severity:'breaking'|'review'|'info';endpoint:string;field:string;expected:unknown;actual:unknown;guidance:string}
export interface CompatibilityReport {status:string;issues:CompatibilityIssue[];truncated:boolean;notice:string}
export function compareContracts(expected:unknown,actual:unknown):CompatibilityReport;
