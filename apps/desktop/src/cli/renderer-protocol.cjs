'use strict';
const {Transform}=require('node:stream');
function boundedLines(maxBytes=4*1024*1024){
 let bytes=0;
 return new Transform({transform(chunk,encoding,callback){
  const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding);
  for(let index=0;index<buffer.length;index++){
   if(buffer[index]===10)bytes=0;
   else if(++bytes>maxBytes){callback(Error('RENDERER_PROTOCOL_TOO_LARGE'));return;}
  }
  callback(null,buffer);
 }});
}
module.exports={boundedLines};
