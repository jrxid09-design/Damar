ai.use(async (ctx, next) => {

    console.log("Before");

    await next();

    console.log("After");

});