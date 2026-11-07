class BaseModel {

    constructor(data = {}) {

        Object.assign(this, data);

    }

    toObject() {

        return { ...this };

    }

    toJSON() {

        return this.toObject();

    }

    clone() {

        return new this.constructor(
            structuredClone(this.toObject())
        );

    }

}

module.exports = BaseModel;