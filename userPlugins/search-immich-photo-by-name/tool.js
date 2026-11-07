// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class SearchImmichPhotoByNameTool {

    constructor() {
        this.name = "searchImmichPhotoByName";
        this.description = "Cari foto orang di Immich lokal berdasarkan nama dan dapatkan URL gambarnya.";
        this.parameters = {
                "name": {
                        "description": "Nama orang yang dicari",
                        "required": true,
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {
        const apiUrl = 'http://127.0.0.1:2283/api';
        const apiKey = process.env.IMMICH_API_KEY;
        const headers = { 'x-api-key': apiKey, 'Accept': 'application/json' };

        const peopleRes = await fetch(`${apiUrl}/person`, { headers });
        if (!peopleRes.ok) {
          return { ok: false, error: `Failed to fetch people: ${peopleRes.statusText}` };
        }
        const people = await peopleRes.json();
        const personList = people.people || people;
        const match = personList.find(p => p.name && p.name.toLowerCase().includes(args.name.toLowerCase()));

        if (!match) {
          return { ok: false, message: `Person standard '${args.name}' not found` };
        }

        const assetsRes = await fetch(`${apiUrl}/person/${match.id}/assets`, { headers });
        if (!assetsRes.ok) {
          return { ok: false, error: `Failed to fetch assets: ${assetsRes.statusText}` };
        }
        const assets = await assetsRes.json();
        const assetList = assets.assets || assets;

        if (!assetList || assetList.length === 0) {
          return { ok: false, message: `No photos found for ${match.name}` };
        }

        const firstAsset = assetList[0];
        const photoUrl = `${apiUrl}/asset/file/${firstAsset.id}?apiKey=${apiKey}`;
        return { ok: true, person: match.name, count: assetList.length, photoUrl, assetId: firstAsset.id };
    }

}

module.exports = [ new SearchImmichPhotoByNameTool() ];
