const GiB=1024**3;
const HARD_FILE_BYTES=64*GiB;
function transferPolicy(options={}){
 const read=(value,fallback,max,label)=>{const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error(`Invalid ${label}; expected a positive integer up to ${max} bytes.`);return n;};
 return {maxFileBytes:read(options.maxFileBytes??process.env.ECHODROP_MAX_FILE_BYTES,8*GiB,HARD_FILE_BYTES,'transfer file limit'),quotaBytes:read(options.quotaBytes??process.env.ECHODROP_TRANSFER_QUOTA_BYTES,32*GiB,256*GiB,'transfer storage quota'),reserveBytes:read(options.reserveBytes??process.env.ECHODROP_DISK_RESERVE_BYTES,64*1024**2,GiB,'disk reserve')};
}
async function requireSpace(fs,directory,bytes,reserve){const s=await fs.statfs(directory);if(s.bavail*s.bsize<bytes+reserve){const e=Error('Insufficient disk space. Free storage and retry; acknowledged chunks remain resumable.');e.code='ENOSPC';e.status=507;throw e;}}
module.exports={HARD_FILE_BYTES,transferPolicy,requireSpace};
