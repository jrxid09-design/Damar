'use strict';
const crypto=require('node:crypto');
// Usage is session-local evidence, not a provider registry or billing database.
class SessionUsage{
 constructor(){this.sessionId=crypto.randomUUID();this.receipts=new Map();this.pending=new Set();this.input=0;this.output=0;}
 begin(requestId){
  if(typeof requestId!=='string'||!requestId||requestId.length>128||this.pending.has(requestId)||this.receipts.has(requestId))throw Error('INVALID_USAGE_REQUEST');
  this.pending.add(requestId);
 }
 record(requestId,usage){
  const input=usage?.input_tokens??usage?.prompt_tokens,output=usage?.output_tokens??usage?.completion_tokens;
  if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)throw Error('AUTHORITATIVE_USAGE_REQUIRED');
  if(usage.input_tokens!==undefined&&usage.prompt_tokens!==undefined&&usage.input_tokens!==usage.prompt_tokens||usage.output_tokens!==undefined&&usage.completion_tokens!==undefined&&usage.output_tokens!==usage.completion_tokens)throw Error('CONFLICTING_USAGE_RECEIPT');
  if(usage.total_tokens!==undefined&&usage.total_tokens!==input+output)throw Error('CONFLICTING_USAGE_RECEIPT');
  const previous=this.receipts.get(requestId);
  if(previous){if(previous.input!==input||previous.output!==output)throw Error('CONFLICTING_USAGE_RECEIPT');return false;}
  if(!this.pending.has(requestId))throw Error('UNKNOWN_USAGE_REQUEST');
  if(!Number.isSafeInteger(this.input+input)||!Number.isSafeInteger(this.output+output)||!Number.isSafeInteger(this.input+input+this.output+output))throw Error('USAGE_OVERFLOW');
  this.receipts.set(requestId,{input,output});this.pending.delete(requestId);this.input+=input;this.output+=output;return true;
 }
 snapshot(){return Object.freeze({sessionId:this.sessionId,inputTokens:this.input,outputTokens:this.output,totalTokens:this.input+this.output,requests:this.receipts.size+this.pending.size,accountedRequests:this.receipts.size,unknownRequests:this.pending.size,complete:this.pending.size===0,source:this.receipts.size?'authoritative-receipts':this.pending.size?'awaiting-authoritative-receipts':'no-inference-dispatched',estimated:false,scope:'current CLI process session only; not global Core billing'});}
}
module.exports={SessionUsage};
