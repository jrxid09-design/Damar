'use strict';
const path=require('node:path');
// Pinned pure-Python renderer dependencies (rich, markdown-it-py, mdurl, pygments) shipped with the CLI.
const PYTHON_VENDOR=path.resolve(__dirname,'../../python-vendor');
function restrictedChildEnvironment(source=process.env){
 const env={};
 for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TERM','COLORTERM','NO_COLOR','LANG','LC_ALL'])
  if(typeof source[key]==='string')env[key]=source[key];
 env.PYTHONIOENCODING='utf-8';env.PYTHONDONTWRITEBYTECODE='1';
 env.PYTHONPATH=PYTHON_VENDOR;env.PYTHONNOUSERSITE='1';
 return env;
}
module.exports={restrictedChildEnvironment};
