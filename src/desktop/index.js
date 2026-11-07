/**
 * SEMANTIC DESKTOP — barrel ekspor substrate V0.
 *
 * Lihat docs/SEMANTIC-DESKTOP.md untuk model domain, batasan dengan
 * Context Intelligence (pipeline prompt), Sensorium (Ox #2), dan
 * Authority (masa depan).
 */

const types = require("./types");
const { DesktopContextCore } = require("./DesktopContextCore");
const Snapshot = require("./ContextSnapshot");
const Resolver = require("./ContextReferenceResolver");
const Projection = require("./CognitionProjection");

module.exports = {
    ENTITY_TYPE: types.ENTITY_TYPE,
    RELATIONSHIP: types.RELATIONSHIP,
    DESKTOP_EVENT: types.DESKTOP_EVENT,
    TRANSITION: types.TRANSITION,
    REASON_CODE: types.REASON_CODE,
    DesktopContextCore,
    ContextSnapshot: Snapshot,
    ContextReferenceResolver: Resolver,
    createCognitionProjection: Projection.createProjection,
    AUTHORITY_NOTE: Projection.AUTHORITY_NOTE
};
