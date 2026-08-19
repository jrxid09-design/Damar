class ChatMessage {

    constructor({
        role,
        content,
        name = null
    } = {}) {

        this.role = role;
        this.content = content;
        this.name = name;

    }

}

module.exports = ChatMessage;