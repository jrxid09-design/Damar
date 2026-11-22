'use strict';
const {main,safeError}=require('./main.cjs');
main(process.argv.slice(2),{prototype:true}).catch(error=>{console.error(safeError(error));process.exitCode=1;});
