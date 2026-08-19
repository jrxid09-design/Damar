const T = require('./.tmp-cron-tool.js');
const t = new T();
const run = async (e) => console.log(JSON.stringify(await t.execute({ expression: e })));
(async () => {
  await run('*/15 9-17 * * 1-5');
  await run('* * * * *');
  await run('0 0 1 jan sun');
  await run('30 14 * * 0,6');
  await run('bad');
  await run('*/15 9-17 * *');
  await run('60 * * * *');
})();
