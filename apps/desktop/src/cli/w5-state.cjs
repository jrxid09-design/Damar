'use strict';
function rendererCursor(editor){
 return Array.from(editor.cells.slice(0,editor.cursor).join('')).length;
}
module.exports={rendererCursor};
