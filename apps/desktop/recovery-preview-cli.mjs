// Standalone possession-based preview only. Does not read app storage or rebind any identity.
import {openRecoveryPackage} from './recovery-package.mjs';
try{const [snapshot,key,projectId,principalId]=process.argv.slice(2);if(process.argv.length!==6)throw Error();const result=await openRecoveryPackage(snapshot,key,{projectId,principalId});process.stdout.write(JSON.stringify(result));}catch{process.stderr.write('Recovery verification failed: check material, identity, scope, expiry and integrity.');process.exitCode=1;}
