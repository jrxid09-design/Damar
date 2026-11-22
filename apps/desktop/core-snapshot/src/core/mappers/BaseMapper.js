class BaseMapper {

    map(data) {
        return data;
    }

    mapArray(items = []) {
        return items.map(item => this.map(item));
    }

}

module.exports = BaseMapper;