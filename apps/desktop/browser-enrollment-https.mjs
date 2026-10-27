import https from 'node:https';
import fs from 'node:fs/promises';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {isIP} from 'node:net';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export function validateEnrollmentTLS({origin,certificate,key}){
 const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==origin)throw Error('Enter an HTTPS origin only, including its listening port.');
 const cert=new X509Certificate(certificate),host=url.hostname.replace(/^\[|\]$/g,'');if(Number(url.port||443)<1||isIP(host)===6)throw Error('Choose a reachable IPv4 address or DNS hostname and a nonzero HTTPS port.');if(Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now()||!cert.subjectAltName||(isIP(host)?!cert.checkIP(host):!cert.checkHost(host))||!cert.checkPrivateKey(createPrivateKey(key)))throw Error('Provide a currently valid matching TLS key and certificate with a SAN for this hostname or IP.');
 return {origin:url.origin,host:url.host,port:Number(url.port||443),fingerprint:cert.fingerprint256};
}
export function createEnrollmentHTTPS(config,enrollment){
 const validated=validateEnrollmentTLS(config);let server;
 const assets=new Map([['/join',new URL('./browser-join.html',import.meta.url)],['/join.js',new URL('./browser-join.js',import.meta.url)],['/join.css',new URL('./browser-join.css',import.meta.url)],['/qr-reader.js',require.resolve('jsqr')]]);
 return{async start(){if(server)return validated;server=https.createServer({cert:config.certificate,key:config.key,minVersion:'TLSv1.3'},async(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");res.setHeader('Permissions-Policy','camera=(self), microphone=()');
   try{
    if(req.headers.host!==validated.host)throw Error('Invalid host.');
    if(req.method==='GET'&&assets.has(req.url)){res.setHeader('Content-Type',req.url==='/join'?'text/html; charset=utf-8':req.url==='/join.css'?'text/css; charset=utf-8':'text/javascript; charset=utf-8');res.end(await fs.readFile(assets.get(req.url)));return;}
    if(req.method!=='POST'||req.headers.origin!==validated.origin||req.headers['content-type']!=='application/json'||!['/challenge','/prove'].includes(req.url))throw Error('Enrollment request denied.');
    let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>8192)throw Error('Request too large.');parts.push(part);}const value=JSON.parse(Buffer.concat(parts).toString('utf8'));const result=req.url==='/challenge'?await enrollment.challenge(value):await enrollment.prove(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
   }catch{if(!res.destroyed){res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Enrollment denied, expired or unavailable. Check the invitation, approval and saved identity; retry status after interruptions.'}));}}
 });server.maxConnections=32;server.requestTimeout=10000;server.headersTimeout=10000;server.on('connection',socket=>socket.setTimeout(15000,()=>socket.destroy()));try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(validated.port,'0.0.0.0',resolve);});}catch(error){server.close();server=undefined;throw error;}return validated;},async stop(){if(server){const current=server;server=undefined;current.closeAllConnections();await new Promise(resolve=>current.close(resolve));}},state:()=>({...validated,listening:Boolean(server?.listening)})};
}
