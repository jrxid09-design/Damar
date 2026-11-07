class CapabilityValidator {

    validate(capability) {

        if (!capability.id)
            throw new Error("Capability id is required.");

        if (!capability.type)
            throw new Error("Capability type is required.");

        if (!capability.name)
            throw new Error("Capability name is required.");

        if (!capability.version)
            throw new Error("Capability version is required.");

        return true;
    }

}

module.exports = new CapabilityValidator();