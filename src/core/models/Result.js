class Result {

    constructor(success, data = null, error = null) {
        this.success = success;
        this.data = data;
        this.error = error;
    }

    static ok(data = null) {
        return new Result(true, data);
    }

    static fail(error) {
        return new Result(false, null, error);
    }

}

module.exports = Result;