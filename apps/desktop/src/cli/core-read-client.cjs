'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {boundedResponse}=require('./service.cjs');

const routes=new Set([
 '/api/v1/console/agents',
 '/api/v1/console/mcp/servers',
 '/api/v1/console/plugins',
 '/api/v1/console/tools',
 '/api/v1/console/safety',
 '/api/v1/console/memory/stats',
 '/api/v1/console/context',
]);
function loopbackUrl(value){
 let url;
 try{url=new URL(value||'http://127.0.0.1:29623');}catch{throw Error('CORE_ENDPOINT_INVALID');}
 if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)||
   url.username||url.password||url.pathname!=='/'||url.search||url.hash)
  throw Error('CORE_ENDPOINT_INVALID');
 return url.origin;
}
class CoreReadClient{
 constructor({baseUrl=process.env.DAMAR_CORE_URL,token=process.env.DAMAR_TOKEN,sessionDirectory,transport=fetch}={}){
  this.baseUrl=loopbackUrl(baseUrl);
  // The run-owned isolated Core host writes its console credential into the private session.
  if(!token&&sessionDirectory)try{token=JSON.parse(fs.readFileSync(path.join(sessionDirectory,'console-credentials.json'),'utf8')).console;}catch{token='';}
  this.token=typeof token==='string'&&token.length<=4096&&!/[\r\n]/.test(token)?token:'';
  this.transport=transport;
 }
 async request(route,{method='GET',body,signal}={}){
  if(!routes.has(route)||method!=='GET'||body!==undefined)throw Error('CORE_ROUTE_DENIED');
  if(!this.token)return {ok:false,status:401,body:null};
  let response;
  try{
   response=await this.transport(this.baseUrl+route,{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(4000)]):AbortSignal.timeout(4000),headers:{accept:'application/json',authorization:'Bearer '+this.token}});
   return {ok:response.ok,status:response.status,body:await boundedResponse(response)};
  }catch{return {ok:false,status:503,body:null};}
 }
}
module.exports={CoreReadClient,loopbackUrl,routes};
