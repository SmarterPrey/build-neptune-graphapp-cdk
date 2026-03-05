"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const gremlin = require("gremlin");
const utils_1 = require("gremlin-aws-sigv4/lib/utils");
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const P = gremlin.process.P;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const TextP = gremlin.process.TextP;
const handler = async (event) => {
    let conn = null;
    const getConnectionDetails = () => {
        return (0, utils_1.getUrlAndHeaders)(process.env.NEPTUNE_ENDPOINT, process.env.NEPTUNE_PORT, {}, "/gremlin", "wss");
    };
    const createRemoteConnection = () => {
        const { url, headers } = getConnectionDetails();
        console.log(url);
        console.log(headers);
        const c = new DriverRemoteConnection(url, {
            mimeType: "application/vnd.gremlin-v2.0+json",
            headers: headers,
        });
        c._client._connection.on("close", (code, message) => {
            console.info(`close - ${code} ${message}`);
            if (code == 1006) {
                console.error("Connection closed prematurely");
                throw new Error("Connection closed prematurely");
            }
        });
        return c;
    };
    let g;
    const type = event.arguments.type;
    console.log(type);
    try {
        if (conn == null) {
            console.info("Initializing connection");
            conn = createRemoteConnection();
            g = traversal().withRemote(conn);
        }
        // Entity search handlers
        const searchConfig = {
            Company: { label: 'Entity', fields: ['companyName'], entityType: 'Company' },
            Customer: { label: 'Entity', fields: ['name'], entityType: 'Customer' },
            Estimator: { label: 'Entity', fields: ['name'], entityType: 'Estimator' },
            Jobber: { label: 'Entity', fields: ['companyName'], entityType: 'Jobber' },
            Asset: { label: 'Asset', fields: ['make', 'model', 'vin'] },
            Job: { label: 'Job', fields: ['jobName'] },
            Part: { label: 'Part', fields: ['partName'] },
            Project_Data: { label: 'Project_Data', fields: ['projectName'] },
        };
        if (event.field === "searchEntities") {
            const { vertexType, searchValue } = event.arguments;
            const cfg = searchConfig[vertexType];
            if (!cfg)
                throw new Error(`Unknown vertex type: ${vertexType}`);
            let searchQuery = g.V().hasLabel(cfg.label);
            if (cfg.entityType) {
                searchQuery = searchQuery.has('entityTypes', cfg.entityType);
            }
            // Only apply text filter if searchValue is non-empty
            const trimmed = (searchValue || '').trim();
            if (trimmed && trimmed !== '*') {
                if (cfg.fields.length === 1) {
                    searchQuery = searchQuery.has(cfg.fields[0], TextP.containing(trimmed));
                }
                else {
                    searchQuery = searchQuery.or(...cfg.fields.map((f) => __.has(f, TextP.containing(trimmed))));
                }
            }
            const results = await searchQuery
                .project('id', 'name', 'label', 'entityType')
                .by(__.id())
                .by(__.coalesce(__.values('companyName'), __.values('name'), __.values('jobName'), __.values('partName'), __.values('make'), __.constant('Unknown')))
                .by(__.label())
                .by(__.coalesce(__.values('entityTypes'), __.constant('')))
                .limit(50)
                .toList();
            return results.map((r) => ({
                id: r.id ?? (r.get ? r.get('id') : undefined),
                name: r.name ?? (r.get ? r.get('name') : undefined),
                label: r.label ?? (r.get ? r.get('label') : undefined),
                entityType: r.entityType || (r.get ? r.get('entityType') : null) || null,
            }));
        }
        if (event.field === "searchProjects") {
            const { searchValue } = event.arguments;
            const trimmed = (searchValue || '').trim();
            let searchQuery = g.V().hasLabel('Project_Data');
            if (trimmed) {
                searchQuery = searchQuery.has('projectName', TextP.startingWith(trimmed));
            }
            const results = await searchQuery
                .project('id', 'projectName', 'DepartmentNumber', 'DataClassification', 'Team', 'OwnerGroup', 'Recovery', 'Tier')
                .by(__.id())
                .by(__.coalesce(__.values('projectName'), __.constant('')))
                .by(__.coalesce(__.values('DepartmentNumber'), __.constant('')))
                .by(__.coalesce(__.values('DataClassification'), __.constant('')))
                .by(__.coalesce(__.values('Team'), __.constant('')))
                .by(__.coalesce(__.values('OwnerGroup'), __.constant('')))
                .by(__.coalesce(__.values('Recovery'), __.constant('')))
                .by(__.coalesce(__.values('Tier'), __.constant('')))
                .limit(200)
                .toList();
            return results.map((r) => ({
                id: r.id ?? (r.get ? r.get('id') : undefined),
                projectName: r.projectName ?? (r.get ? r.get('projectName') : ''),
                DepartmentNumber: r.DepartmentNumber ?? (r.get ? r.get('DepartmentNumber') : ''),
                DataClassification: r.DataClassification ?? (r.get ? r.get('DataClassification') : ''),
                Team: r.Team ?? (r.get ? r.get('Team') : ''),
                OwnerGroup: r.OwnerGroup ?? (r.get ? r.get('OwnerGroup') : ''),
                Recovery: r.Recovery ?? (r.get ? r.get('Recovery') : ''),
                Tier: r.Tier ?? (r.get ? r.get('Tier') : ''),
            }));
        }
        if (event.field === "getEntityProperties" || event.field === "getEntityEdges") {
            const { vertexType, searchValue, vertexId: directVertexId } = event.arguments;
            const cfg = searchConfig[vertexType];
            if (!cfg)
                throw new Error(`Unknown vertex type: ${vertexType}`);
            let vertexId = directVertexId;
            if (!vertexId) {
                let searchQuery = g.V().hasLabel(cfg.label);
                if (cfg.entityType) {
                    searchQuery = searchQuery.has('entityTypes', cfg.entityType);
                }
                const trimmedSv = (searchValue || '').trim();
                if (trimmedSv && trimmedSv !== '*') {
                    if (cfg.fields.length === 1) {
                        searchQuery = searchQuery.has(cfg.fields[0], TextP.containing(trimmedSv));
                    }
                    else {
                        searchQuery = searchQuery.or(...cfg.fields.map((f) => __.has(f, TextP.containing(trimmedSv))));
                    }
                }
                const vertexIds = await searchQuery.id().limit(1).toList();
                if (vertexIds.length === 0)
                    return [];
                vertexId = vertexIds[0];
            }
            if (event.field === "getEntityProperties") {
                const result = await g.V(vertexId).valueMap().toList();
                if (result.length === 0)
                    return [];
                const vertexMap = result[0];
                const properties = [];
                const entries = vertexMap instanceof Map ? Array.from(vertexMap.entries()) : Object.entries(vertexMap);
                for (const [key, val] of entries) {
                    const propValue = Array.isArray(val) ? String(val[0]) : String(val);
                    if (propValue !== undefined && propValue !== 'undefined' && propValue !== '') {
                        properties.push({ key: String(key), value: propValue });
                    }
                }
                return properties;
            }
            if (event.field === "getEntityEdges") {
                const outEdges = await g.V(vertexId)
                    .outE()
                    .project('edgeLabel', 'targetLabel', 'targetName')
                    .by(__.label())
                    .by(__.inV().label())
                    .by(__.inV().coalesce(__.values('companyName'), __.values('name'), __.values('jobName'), __.values('partName'), __.values('make'), __.constant('Unknown')))
                    .toList();
                const inEdges = await g.V(vertexId)
                    .inE()
                    .project('edgeLabel', 'targetLabel', 'targetName')
                    .by(__.label())
                    .by(__.outV().label())
                    .by(__.outV().coalesce(__.values('companyName'), __.values('name'), __.values('jobName'), __.values('partName'), __.values('make'), __.constant('Unknown')))
                    .toList();
                const edges = [];
                for (const e of outEdges) {
                    edges.push({
                        edgeLabel: e.edgeLabel ?? (e.get ? e.get('edgeLabel') : ''),
                        direction: 'outgoing',
                        targetLabel: e.targetLabel ?? (e.get ? e.get('targetLabel') : ''),
                        targetName: e.targetName ?? (e.get ? e.get('targetName') : ''),
                    });
                }
                for (const e of inEdges) {
                    edges.push({
                        edgeLabel: e.edgeLabel ?? (e.get ? e.get('edgeLabel') : ''),
                        direction: 'incoming',
                        targetLabel: e.targetLabel ?? (e.get ? e.get('targetLabel') : ''),
                        targetName: e.targetName ?? (e.get ? e.get('targetName') : ''),
                    });
                }
                return edges;
            }
        }
        if (type === "profile") {
            console.log(g);
            let usage;
            let belong_to;
            let authored_by;
            let affiliated_with;
            let people;
            let made_by;
            let search_name = await g
                .V(event.arguments.name)
                .values("name")
                .toList();
            switch (event.arguments.value) {
                case "person":
                    usage = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .bothE()
                        .hasLabel("usage")
                        .otherV()
                        .values("name")
                        .toList();
                    belong_to = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .bothE()
                        .hasLabel("belong_to")
                        .otherV()
                        .values("name")
                        .toList();
                    authored_by = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .bothE()
                        .hasLabel("authored_by")
                        .otherV()
                        .values("name")
                        .toList();
                    affiliated_with = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .bothE()
                        .hasLabel("affiliated_with")
                        .otherV()
                        .values("name")
                        .toList();
                    return [
                        { search_name, usage, belong_to, authored_by, affiliated_with },
                    ];
                case "id":
                    usage = await g
                        .V()
                        .hasId(event.arguments.name)
                        .bothE()
                        .hasLabel("usage")
                        .otherV()
                        .values("name")
                        .toList();
                    if (event.arguments.name.match(/Doc/)) {
                        belong_to = await g
                            .V()
                            .hasId(event.arguments.name)
                            .bothE()
                            .hasLabel("belong_to")
                            .otherV()
                            .values("name")
                            .toList();
                    }
                    else {
                        belong_to = [];
                    }
                    authored_by = await g
                        .V()
                        .hasId(event.arguments.name)
                        .bothE()
                        .hasLabel("authored_by")
                        .otherV()
                        .values("name")
                        .toList();
                    affiliated_with = await g
                        .V()
                        .hasId(event.arguments.name)
                        .bothE()
                        .hasLabel("affiliated_with")
                        .otherV()
                        .values("name")
                        .toList();
                    if (event.arguments.name.match(/Prod/)) {
                        made_by = await g
                            .V()
                            .hasId(event.arguments.name)
                            .out("made_by")
                            .values("name")
                            .toList();
                    }
                    else {
                        made_by = [];
                    }
                    if (event.arguments.name.match(/Conf/)) {
                        people = await g
                            .V()
                            .hasId(event.arguments.name)
                            .in_()
                            .values("name")
                            .toList();
                    }
                    else {
                        people = [];
                    }
                    if (event.arguments.name.match(/Inst/)) {
                        affiliated_with = [];
                    }
                    return [
                        {
                            search_name,
                            usage,
                            belong_to,
                            authored_by,
                            affiliated_with,
                            made_by,
                            people,
                        },
                    ];
                case "product":
                    console.log(event.arguments);
                    made_by = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .out("made_by")
                        .values("name")
                        .toList();
                    return [{ search_name, made_by }];
                case "conference":
                    console.log(event.arguments);
                    people = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .in_()
                        .values("name")
                        .toList();
                    return [{ search_name, people }];
                default:
                    console.log("default");
            }
        }
        else if (type === "relation") {
            switch (event.arguments.value) {
                case "person":
                    const result = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .as(event.arguments.value)
                        .out("belong_to")
                        .in_()
                        .where(P.neq(event.arguments.value))
                        .values("name")
                        .dedup()
                        .toList();
                    return result.map((r) => {
                        return { name: r };
                    });
                case "product":
                    const result2 = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .as(event.arguments.value)
                        .in_("usage")
                        .as("p")
                        .in_("authored_by")
                        .out()
                        .where(P.neq("p"))
                        .values("name")
                        .dedup()
                        .toList();
                    return result2.map((r) => {
                        return { name: r };
                    });
                case "conference":
                    console.log(event.arguments);
                    const result3 = await g
                        .V()
                        .has(event.arguments.value, "name", event.arguments.name)
                        .as(event.arguments.value)
                        .in_()
                        .as("p")
                        .out()
                        .hasLabel("person")
                        .where(P.neq("p"))
                        .values("name")
                        .dedup()
                        .toList();
                    console.log(result3);
                    return result3.map((r) => {
                        return { name: r };
                    });
                default:
                    console.log("default");
            }
        }
        else {
            const result = await g.V().toList();
            const vertex = result.map((r) => {
                return { id: r.id, label: r.label };
            });
            const result2 = await g.E().toList();
            const edge = result2.map((r) => {
                console.log(r);
                return { source: r.outV.id, target: r.inV.id, value: r.label };
            });
            return { nodes: vertex, links: edge };
        }
    }
    catch (error) {
        console.log(error);
        console.error(JSON.stringify(error));
        throw error;
    }
};
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicXVlcnlHcmFwaC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInF1ZXJ5R3JhcGgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBRUEsbUNBQW1DO0FBQ25DLHVEQUErRDtBQUUvRCxNQUFNLHNCQUFzQixHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsc0JBQXNCLENBQUM7QUFDckUsTUFBTSxDQUFDLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDNUIsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyx3QkFBd0IsQ0FBQyxTQUFTLENBQUM7QUFDckUsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7QUFDbkMsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUM7QUFDN0IsTUFBTSxPQUFPLEdBQVksS0FBSyxFQUFFLEtBQUssRUFBRSxFQUFFO0lBQzlDLElBQUksSUFBSSxHQUFHLElBQUksQ0FBQztJQUNoQixNQUFNLG9CQUFvQixHQUFHLEdBQUcsRUFBRTtRQUNoQyxPQUFPLElBQUEsd0JBQWdCLEVBQ3JCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLEVBQzVCLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxFQUN4QixFQUFFLEVBQ0YsVUFBVSxFQUNWLEtBQUssQ0FDTixDQUFDO0lBQ0osQ0FBQyxDQUFDO0lBRUYsTUFBTSxzQkFBc0IsR0FBRyxHQUFHLEVBQUU7UUFDbEMsTUFBTSxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsR0FBRyxvQkFBb0IsRUFBRSxDQUFDO1FBRWhELE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDakIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNyQixNQUFNLENBQUMsR0FBRyxJQUFJLHNCQUFzQixDQUFDLEdBQUcsRUFBRTtZQUN4QyxRQUFRLEVBQUUsbUNBQW1DO1lB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QUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFNLEVBQUUsRUFBRTtnQkFDbEMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDZixPQUFPLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ2pFLENBQUMsQ0FBQyxDQUFDO1lBQ0gsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDO1FBQ3hDLENBQUM7SUFDSCxDQUFDO0lBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztRQUNwQixPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ25CLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3JDLE1BQU0sS0FBSyxDQUFDO0lBQ2QsQ0FBQztBQUNILENBQUMsQ0FBQztBQXZiVyxRQUFBLE9BQU8sV0F1YmxCIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgSGFuZGxlciB9IGZyb20gXCJhd3MtbGFtYmRhXCI7XG5cbmltcG9ydCAqIGFzIGdyZW1saW4gZnJvbSBcImdyZW1saW5cIjtcbmltcG9ydCB7IGdldFVybEFuZEhlYWRlcnMgfSBmcm9tIFwiZ3JlbWxpbi1hd3Mtc2lndjQvbGliL3V0aWxzXCI7XG5cbmNvbnN0IERyaXZlclJlbW90ZUNvbm5lY3Rpb24gPSBncmVtbGluLmRyaXZlci5Ecml2ZXJSZW1vdGVDb25uZWN0aW9uO1xuY29uc3QgUCA9IGdyZW1saW4ucHJvY2Vzcy5QO1xuY29uc3QgdHJhdmVyc2FsID0gZ3JlbWxpbi5wcm9jZXNzLkFub255bW91c1RyYXZlcnNhbFNvdXJjZS50cmF2ZXJzYWw7XG5jb25zdCBfXyA9IGdyZW1saW4ucHJvY2Vzcy5zdGF0aWNzO1xuY29uc3QgVGV4dFAgPSBncmVtbGluLnByb2Nlc3MuVGV4dFA7XG5leHBvcnQgY29uc3QgaGFuZGxlcjogSGFuZGxlciA9IGFzeW5jIChldmVudCkgPT4ge1xuICBsZXQgY29ubiA9IG51bGw7XG4gIGNvbnN0IGdldENvbm5lY3Rpb25EZXRhaWxzID0gKCkgPT4ge1xuICAgIHJldHVybiBnZXRVcmxBbmRIZWFkZXJzKFxuICAgICAgcHJvY2Vzcy5lbnYuTkVQVFVORV9FTkRQT0lOVCxcbiAgICAgIHByb2Nlc3MuZW52Lk5FUFRVTkVfUE9SVCxcbiAgICAgIHt9LFxuICAgICAgXCIvZ3JlbWxpblwiLFxuICAgICAgXCJ3c3NcIlxuICAgICk7XG4gIH07XG5cbiAgY29uc3QgY3JlYXRlUmVtb3RlQ29ubmVjdGlvbiA9ICgpID0+IHtcbiAgICBjb25zdCB7IHVybCwgaGVhZGVycyB9ID0gZ2V0Q29ubmVjdGlvbkRldGFpbHMoKTtcblxuICAgIGNvbnNvbGUubG9nKHVybCk7XG4gICAgY29uc29sZS5sb2coaGVhZGVycyk7XG4gICAgY29uc3QgYyA9IG5ldyBEcml2ZXJSZW1vdGVDb25uZWN0aW9uKHVybCwge1xuICAgICAgbWltZVR5cGU6IFwiYXBwbGljYXRpb24vdm5kLmdyZW1saW4tdjIuMCtqc29uXCIsXG4gICAgICBoZWFkZXJzOiBoZWFkZXJzLFxuICAgIH0pO1xuICAgIGMuX2NsaWVudC5fY29ubmVjdGlvbi5vbihcImNsb3NlXCIsIChjb2RlLCBtZXNzYWdlKSA9PiB7XG4gICAgICBjb25zb2xlLmluZm8oYGNsb3NlIC0gJHtjb2RlfSAke21lc3NhZ2V9YCk7XG4gICAgICBpZiAoY29kZSA9PSAxMDA2KSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJDb25uZWN0aW9uIGNsb3NlZCBwcmVtYXR1cmVseVwiKTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ29ubmVjdGlvbiBjbG9zZWQgcHJlbWF0dXJlbHlcIik7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIGM7XG4gIH07XG5cbiAgbGV0IGc7XG5cbiAgY29uc3QgdHlwZSA9IGV2ZW50LmFyZ3VtZW50cy50eXBlO1xuICBjb25zb2xlLmxvZyh0eXBlKTtcbiAgdHJ5IHtcbiAgICBpZiAoY29ubiA9PSBudWxsKSB7XG4gICAgICBjb25zb2xlLmluZm8oXCJJbml0aWFsaXppbmcgY29ubmVjdGlvblwiKTtcbiAgICAgIGNvbm4gPSBjcmVhdGVSZW1vdGVDb25uZWN0aW9uKCk7XG4gICAgICBnID0gdHJhdmVyc2FsKCkud2l0aFJlbW90ZShjb25uKTtcbiAgICB9XG5cbiAgICAvLyBFbnRpdHkgc2VhcmNoIGhhbmRsZXJzXG4gICAgY29uc3Qgc2VhcmNoQ29uZmlnOiBSZWNvcmQ8c3RyaW5nLCB7IGxhYmVsOiBzdHJpbmc7IGZpZWxkczogc3RyaW5nW107IGVudGl0eVR5cGU/OiBzdHJpbmcgfT4gPSB7XG4gICAgICBDb21wYW55OiB7IGxhYmVsOiAnRW50aXR5JywgZmllbGRzOiBbJ2NvbXBhbnlOYW1lJ10sIGVudGl0eVR5cGU6ICdDb21wYW55JyB9LFxuICAgICAgQ3VzdG9tZXI6IHsgbGFiZWw6ICdFbnRpdHknLCBmaWVsZHM6IFsnbmFtZSddLCBlbnRpdHlUeXBlOiAnQ3VzdG9tZXInIH0sXG4gICAgICBFc3RpbWF0b3I6IHsgbGFiZWw6ICdFbnRpdHknLCBmaWVsZHM6IFsnbmFtZSddLCBlbnRpdHlUeXBlOiAnRXN0aW1hdG9yJyB9LFxuICAgICAgSm9iYmVyOiB7IGxhYmVsOiAnRW50aXR5JywgZmllbGRzOiBbJ2NvbXBhbnlOYW1lJ10sIGVudGl0eVR5cGU6ICdKb2JiZXInIH0sXG4gICAgICBBc3NldDogeyBsYWJlbDogJ0Fzc2V0JywgZmllbGRzOiBbJ21ha2UnLCAnbW9kZWwnLCAndmluJ10gfSxcbiAgICAgIEpvYjogeyBsYWJlbDogJ0pvYicsIGZpZWxkczogWydqb2JOYW1lJ10gfSxcbiAgICAgIFBhcnQ6IHsgbGFiZWw6ICdQYXJ0JywgZmllbGRzOiBbJ3BhcnROYW1lJ10gfSxcbiAgICAgIFByb2plY3RfRGF0YTogeyBsYWJlbDogJ1Byb2plY3RfRGF0YScsIGZpZWxkczogWydwcm9qZWN0TmFtZSddIH0sXG4gICAgfTtcblxuICAgIGlmIChldmVudC5maWVsZCA9PT0gXCJzZWFyY2hFbnRpdGllc1wiKSB7XG4gICAgICBjb25zdCB7IHZlcnRleFR5cGUsIHNlYXJjaFZhbHVlIH0gPSBldmVudC5hcmd1bWVudHM7XG4gICAgICBjb25zdCBjZmcgPSBzZWFyY2hDb25maWdbdmVydGV4VHlwZV07XG4gICAgICBpZiAoIWNmZykgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIHZlcnRleCB0eXBlOiAke3ZlcnRleFR5cGV9YCk7XG5cbiAgICAgIGxldCBzZWFyY2hRdWVyeSA9IGchLlYoKS5oYXNMYWJlbChjZmcubGFiZWwpO1xuICAgICAgaWYgKGNmZy5lbnRpdHlUeXBlKSB7XG4gICAgICAgIHNlYXJjaFF1ZXJ5ID0gc2VhcmNoUXVlcnkuaGFzKCdlbnRpdHlUeXBlcycsIGNmZy5lbnRpdHlUeXBlKTtcbiAgICAgIH1cblxuICAgICAgLy8gT25seSBhcHBseSB0ZXh0IGZpbHRlciBpZiBzZWFyY2hWYWx1ZSBpcyBub24tZW1wdHlcbiAgICAgIGNvbnN0IHRyaW1tZWQgPSAoc2VhcmNoVmFsdWUgfHwgJycpLnRyaW0oKTtcbiAgICAgIGlmICh0cmltbWVkICYmIHRyaW1tZWQgIT09ICcqJykge1xuICAgICAgICBpZiAoY2ZnLmZpZWxkcy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICBzZWFyY2hRdWVyeSA9IHNlYXJjaFF1ZXJ5LmhhcyhjZmcuZmllbGRzWzBdLCBUZXh0UC5jb250YWluaW5nKHRyaW1tZWQpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzZWFyY2hRdWVyeSA9IHNlYXJjaFF1ZXJ5Lm9yKFxuICAgICAgICAgICAgLi4uY2ZnLmZpZWxkcy5tYXAoKGY6IHN0cmluZykgPT4gX18uaGFzKGYsIFRleHRQLmNvbnRhaW5pbmcodHJpbW1lZCkpKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHNlYXJjaFF1ZXJ5XG4gICAgICAgIC5wcm9qZWN0KCdpZCcsICduYW1lJywgJ2xhYmVsJywgJ2VudGl0eVR5cGUnKVxuICAgICAgICAuYnkoX18uaWQoKSlcbiAgICAgICAgLmJ5KF9fLmNvYWxlc2NlKFxuICAgICAgICAgIF9fLnZhbHVlcygnY29tcGFueU5hbWUnKSxcbiAgICAgICAgICBfXy52YWx1ZXMoJ25hbWUnKSxcbiAgICAgICAgICBfXy52YWx1ZXMoJ2pvYk5hbWUnKSxcbiAgICAgICAgICBfXy52YWx1ZXMoJ3BhcnROYW1lJyksXG4gICAgICAgICAgX18udmFsdWVzKCdtYWtlJyksXG4gICAgICAgICAgX18uY29uc3RhbnQoJ1Vua25vd24nKVxuICAgICAgICApKVxuICAgICAgICAuYnkoX18ubGFiZWwoKSlcbiAgICAgICAgLmJ5KF9fLmNvYWxlc2NlKF9fLnZhbHVlcygnZW50aXR5VHlwZXMnKSwgX18uY29uc3RhbnQoJycpKSlcbiAgICAgICAgLmxpbWl0KDUwKVxuICAgICAgICAudG9MaXN0KCk7XG5cbiAgICAgIHJldHVybiByZXN1bHRzLm1hcCgocjogYW55KSA9PiAoe1xuICAgICAgICBpZDogci5pZCA/PyAoci5nZXQgPyByLmdldCgnaWQnKSA6IHVuZGVmaW5lZCksXG4gICAgICAgIG5hbWU6IHIubmFtZSA/PyAoci5nZXQgPyByLmdldCgnbmFtZScpIDogdW5kZWZpbmVkKSxcbiAgICAgICAgbGFiZWw6IHIubGFiZWwgPz8gKHIuZ2V0ID8gci5nZXQoJ2xhYmVsJykgOiB1bmRlZmluZWQpLFxuICAgICAgICBlbnRpdHlUeXBlOiByLmVudGl0eVR5cGUgfHwgKHIuZ2V0ID8gci5nZXQoJ2VudGl0eVR5cGUnKSA6IG51bGwpIHx8IG51bGwsXG4gICAgICB9KSk7XG4gICAgfVxuXG4gICAgaWYgKGV2ZW50LmZpZWxkID09PSBcInNlYXJjaFByb2plY3RzXCIpIHtcbiAgICAgIGNvbnN0IHsgc2VhcmNoVmFsdWUgfSA9IGV2ZW50LmFyZ3VtZW50cztcbiAgICAgIGNvbnN0IHRyaW1tZWQgPSAoc2VhcmNoVmFsdWUgfHwgJycpLnRyaW0oKTtcblxuICAgICAgbGV0IHNlYXJjaFF1ZXJ5ID0gZyEuVigpLmhhc0xhYmVsKCdQcm9qZWN0X0RhdGEnKTtcbiAgICAgIGlmICh0cmltbWVkKSB7XG4gICAgICAgIHNlYXJjaFF1ZXJ5ID0gc2VhcmNoUXVlcnkuaGFzKCdwcm9qZWN0TmFtZScsIFRleHRQLnN0YXJ0aW5nV2l0aCh0cmltbWVkKSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBzZWFyY2hRdWVyeVxuICAgICAgICAucHJvamVjdCgnaWQnLCAncHJvamVjdE5hbWUnLCAnRGVwYXJ0bWVudE51bWJlcicsICdEYXRhQ2xhc3NpZmljYXRpb24nLCAnVGVhbScsICdPd25lckdyb3VwJywgJ1JlY292ZXJ5JywgJ1RpZXInKVxuICAgICAgICAuYnkoX18uaWQoKSlcbiAgICAgICAgLmJ5KF9fLmNvYWxlc2NlKF9fLnZhbHVlcygncHJvamVjdE5hbWUnKSwgX18uY29uc3RhbnQoJycpKSlcbiAgICAgICAgLmJ5KF9fLmNvYWxlc2NlKF9fLnZhbHVlcygnRGVwYXJ0bWVudE51bWJlcicpLCBfXy5jb25zdGFudCgnJykpKVxuICAgICAgICAuYnkoX18uY29hbGVzY2UoX18udmFsdWVzKCdEYXRhQ2xhc3NpZmljYXRpb24nKSwgX18uY29uc3RhbnQoJycpKSlcbiAgICAgICAgLmJ5KF9fLmNvYWxlc2NlKF9fLnZhbHVlcygnVGVhbScpLCBfXy5jb25zdGFudCgnJykpKVxuICAgICAgICAuYnkoX18uY29hbGVzY2UoX18udmFsdWVzKCdPd25lckdyb3VwJyksIF9fLmNvbnN0YW50KCcnKSkpXG4gICAgICAgIC5ieShfXy5jb2FsZXNjZShfXy52YWx1ZXMoJ1JlY292ZXJ5JyksIF9fLmNvbnN0YW50KCcnKSkpXG4gICAgICAgIC5ieShfXy5jb2FsZXNjZShfXy52YWx1ZXMoJ1RpZXInKSwgX18uY29uc3RhbnQoJycpKSlcbiAgICAgICAgLmxpbWl0KDIwMClcbiAgICAgICAgLnRvTGlzdCgpO1xuXG4gICAgICByZXR1cm4gcmVzdWx0cy5tYXAoKHI6IGFueSkgPT4gKHtcbiAgICAgICAgaWQ6IHIuaWQgPz8gKHIuZ2V0ID8gci5nZXQoJ2lkJykgOiB1bmRlZmluZWQpLFxuICAgICAgICBwcm9qZWN0TmFtZTogci5wcm9qZWN0TmFtZSA/PyAoci5nZXQgPyByLmdldCgncHJvamVjdE5hbWUnKSA6ICcnKSxcbiAgICAgICAgRGVwYXJ0bWVudE51bWJlcjogci5EZXBhcnRtZW50TnVtYmVyID8/IChyLmdldCA/IHIuZ2V0KCdEZXBhcnRtZW50TnVtYmVyJykgOiAnJyksXG4gICAgICAgIERhdGFDbGFzc2lmaWNhdGlvbjogci5EYXRhQ2xhc3NpZmljYXRpb24gPz8gKHIuZ2V0ID8gci5nZXQoJ0RhdGFDbGFzc2lmaWNhdGlvbicpIDogJycpLFxuICAgICAgICBUZWFtOiByLlRlYW0gPz8gKHIuZ2V0ID8gci5nZXQoJ1RlYW0nKSA6ICcnKSxcbiAgICAgICAgT3duZXJHcm91cDogci5Pd25lckdyb3VwID8/IChyLmdldCA/IHIuZ2V0KCdPd25lckdyb3VwJykgOiAnJyksXG4gICAgICAgIFJlY292ZXJ5OiByLlJlY292ZXJ5ID8/IChyLmdldCA/IHIuZ2V0KCdSZWNvdmVyeScpIDogJycpLFxuICAgICAgICBUaWVyOiByLlRpZXIgPz8gKHIuZ2V0ID8gci5nZXQoJ1RpZXInKSA6ICcnKSxcbiAgICAgIH0pKTtcbiAgICB9XG5cbiAgICBpZiAoZXZlbnQuZmllbGQgPT09IFwiZ2V0RW50aXR5UHJvcGVydGllc1wiIHx8IGV2ZW50LmZpZWxkID09PSBcImdldEVudGl0eUVkZ2VzXCIpIHtcbiAgICAgIGNvbnN0IHsgdmVydGV4VHlwZSwgc2VhcmNoVmFsdWUsIHZlcnRleElkOiBkaXJlY3RWZXJ0ZXhJZCB9ID0gZXZlbnQuYXJndW1lbnRzO1xuICAgICAgY29uc3QgY2ZnID0gc2VhcmNoQ29uZmlnW3ZlcnRleFR5cGVdO1xuICAgICAgaWYgKCFjZmcpIHRocm93IG5ldyBFcnJvcihgVW5rbm93biB2ZXJ0ZXggdHlwZTogJHt2ZXJ0ZXhUeXBlfWApO1xuXG4gICAgICBsZXQgdmVydGV4SWQgPSBkaXJlY3RWZXJ0ZXhJZDtcbiAgICAgIGlmICghdmVydGV4SWQpIHtcbiAgICAgICAgbGV0IHNlYXJjaFF1ZXJ5ID0gZyEuVigpLmhhc0xhYmVsKGNmZy5sYWJlbCk7XG4gICAgICAgIGlmIChjZmcuZW50aXR5VHlwZSkge1xuICAgICAgICAgIHNlYXJjaFF1ZXJ5ID0gc2VhcmNoUXVlcnkuaGFzKCdlbnRpdHlUeXBlcycsIGNmZy5lbnRpdHlUeXBlKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0cmltbWVkU3YgPSAoc2VhcmNoVmFsdWUgfHwgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKHRyaW1tZWRTdiAmJiB0cmltbWVkU3YgIT09ICcqJykge1xuICAgICAgICAgIGlmIChjZmcuZmllbGRzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgc2VhcmNoUXVlcnkgPSBzZWFyY2hRdWVyeS5oYXMoY2ZnLmZpZWxkc1swXSwgVGV4dFAuY29udGFpbmluZyh0cmltbWVkU3YpKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2VhcmNoUXVlcnkgPSBzZWFyY2hRdWVyeS5vcihcbiAgICAgICAgICAgICAgLi4uY2ZnLmZpZWxkcy5tYXAoKGY6IHN0cmluZykgPT4gX18uaGFzKGYsIFRleHRQLmNvbnRhaW5pbmcodHJpbW1lZFN2KSkpXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb25zdCB2ZXJ0ZXhJZHMgPSBhd2FpdCBzZWFyY2hRdWVyeS5pZCgpLmxpbWl0KDEpLnRvTGlzdCgpO1xuICAgICAgICBpZiAodmVydGV4SWRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgICAgICB2ZXJ0ZXhJZCA9IHZlcnRleElkc1swXTtcbiAgICAgIH1cblxuICAgICAgaWYgKGV2ZW50LmZpZWxkID09PSBcImdldEVudGl0eVByb3BlcnRpZXNcIikge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBnIS5WKHZlcnRleElkKS52YWx1ZU1hcCgpLnRvTGlzdCgpO1xuICAgICAgICBpZiAocmVzdWx0Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgICAgICBjb25zdCB2ZXJ0ZXhNYXAgPSByZXN1bHRbMF07XG4gICAgICAgIGNvbnN0IHByb3BlcnRpZXM6IEFycmF5PHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfT4gPSBbXTtcbiAgICAgICAgY29uc3QgZW50cmllcyA9IHZlcnRleE1hcCBpbnN0YW5jZW9mIE1hcCA/IEFycmF5LmZyb20odmVydGV4TWFwLmVudHJpZXMoKSkgOiBPYmplY3QuZW50cmllcyh2ZXJ0ZXhNYXApO1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgZW50cmllcykge1xuICAgICAgICAgIGNvbnN0IHByb3BWYWx1ZSA9IEFycmF5LmlzQXJyYXkodmFsKSA/IFN0cmluZyh2YWxbMF0pIDogU3RyaW5nKHZhbCk7XG4gICAgICAgICAgaWYgKHByb3BWYWx1ZSAhPT0gdW5kZWZpbmVkICYmIHByb3BWYWx1ZSAhPT0gJ3VuZGVmaW5lZCcgJiYgcHJvcFZhbHVlICE9PSAnJykge1xuICAgICAgICAgICAgcHJvcGVydGllcy5wdXNoKHsga2V5OiBTdHJpbmcoa2V5KSwgdmFsdWU6IHByb3BWYWx1ZSB9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHByb3BlcnRpZXM7XG4gICAgICB9XG5cbiAgICAgIGlmIChldmVudC5maWVsZCA9PT0gXCJnZXRFbnRpdHlFZGdlc1wiKSB7XG4gICAgICAgIGNvbnN0IG91dEVkZ2VzID0gYXdhaXQgZyEuVih2ZXJ0ZXhJZClcbiAgICAgICAgICAub3V0RSgpXG4gICAgICAgICAgLnByb2plY3QoJ2VkZ2VMYWJlbCcsICd0YXJnZXRMYWJlbCcsICd0YXJnZXROYW1lJylcbiAgICAgICAgICAuYnkoX18ubGFiZWwoKSlcbiAgICAgICAgICAuYnkoX18uaW5WKCkubGFiZWwoKSlcbiAgICAgICAgICAuYnkoX18uaW5WKCkuY29hbGVzY2UoXG4gICAgICAgICAgICBfXy52YWx1ZXMoJ2NvbXBhbnlOYW1lJyksXG4gICAgICAgICAgICBfXy52YWx1ZXMoJ25hbWUnKSxcbiAgICAgICAgICAgIF9fLnZhbHVlcygnam9iTmFtZScpLFxuICAgICAgICAgICAgX18udmFsdWVzKCdwYXJ0TmFtZScpLFxuICAgICAgICAgICAgX18udmFsdWVzKCdtYWtlJyksXG4gICAgICAgICAgICBfXy5jb25zdGFudCgnVW5rbm93bicpXG4gICAgICAgICAgKSlcbiAgICAgICAgICAudG9MaXN0KCk7XG5cbiAgICAgICAgY29uc3QgaW5FZGdlcyA9IGF3YWl0IGchLlYodmVydGV4SWQpXG4gICAgICAgICAgLmluRSgpXG4gICAgICAgICAgLnByb2plY3QoJ2VkZ2VMYWJlbCcsICd0YXJnZXRMYWJlbCcsICd0YXJnZXROYW1lJylcbiAgICAgICAgICAuYnkoX18ubGFiZWwoKSlcbiAgICAgICAgICAuYnkoX18ub3V0VigpLmxhYmVsKCkpXG4gICAgICAgICAgLmJ5KF9fLm91dFYoKS5jb2FsZXNjZShcbiAgICAgICAgICAgIF9fLnZhbHVlcygnY29tcGFueU5hbWUnKSxcbiAgICAgICAgICAgIF9fLnZhbHVlcygnbmFtZScpLFxuICAgICAgICAgICAgX18udmFsdWVzKCdqb2JOYW1lJyksXG4gICAgICAgICAgICBfXy52YWx1ZXMoJ3BhcnROYW1lJyksXG4gICAgICAgICAgICBfXy52YWx1ZXMoJ21ha2UnKSxcbiAgICAgICAgICAgIF9fLmNvbnN0YW50KCdVbmtub3duJylcbiAgICAgICAgICApKVxuICAgICAgICAgIC50b0xpc3QoKTtcblxuICAgICAgICBjb25zdCBlZGdlczogQXJyYXk8eyBlZGdlTGFiZWw6IHN0cmluZzsgZGlyZWN0aW9uOiBzdHJpbmc7IHRhcmdldExhYmVsOiBzdHJpbmc7IHRhcmdldE5hbWU6IHN0cmluZyB9PiA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGUgb2Ygb3V0RWRnZXMpIHtcbiAgICAgICAgICBlZGdlcy5wdXNoKHtcbiAgICAgICAgICAgIGVkZ2VMYWJlbDogZS5lZGdlTGFiZWwgPz8gKGUuZ2V0ID8gZS5nZXQoJ2VkZ2VMYWJlbCcpIDogJycpLFxuICAgICAgICAgICAgZGlyZWN0aW9uOiAnb3V0Z29pbmcnLFxuICAgICAgICAgICAgdGFyZ2V0TGFiZWw6IGUudGFyZ2V0TGFiZWwgPz8gKGUuZ2V0ID8gZS5nZXQoJ3RhcmdldExhYmVsJykgOiAnJyksXG4gICAgICAgICAgICB0YXJnZXROYW1lOiBlLnRhcmdldE5hbWUgPz8gKGUuZ2V0ID8gZS5nZXQoJ3RhcmdldE5hbWUnKSA6ICcnKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGUgb2YgaW5FZGdlcykge1xuICAgICAgICAgIGVkZ2VzLnB1c2goe1xuICAgICAgICAgICAgZWRnZUxhYmVsOiBlLmVkZ2VMYWJlbCA/PyAoZS5nZXQgPyBlLmdldCgnZWRnZUxhYmVsJykgOiAnJyksXG4gICAgICAgICAgICBkaXJlY3Rpb246ICdpbmNvbWluZycsXG4gICAgICAgICAgICB0YXJnZXRMYWJlbDogZS50YXJnZXRMYWJlbCA/PyAoZS5nZXQgPyBlLmdldCgndGFyZ2V0TGFiZWwnKSA6ICcnKSxcbiAgICAgICAgICAgIHRhcmdldE5hbWU6IGUudGFyZ2V0TmFtZSA/PyAoZS5nZXQgPyBlLmdldCgndGFyZ2V0TmFtZScpIDogJycpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBlZGdlcztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodHlwZSA9PT0gXCJwcm9maWxlXCIpIHtcbiAgICAgIGNvbnNvbGUubG9nKGcpO1xuICAgICAgbGV0IHVzYWdlO1xuICAgICAgbGV0IGJlbG9uZ190bztcbiAgICAgIGxldCBhdXRob3JlZF9ieTtcbiAgICAgIGxldCBhZmZpbGlhdGVkX3dpdGg7XG4gICAgICBsZXQgcGVvcGxlO1xuICAgICAgbGV0IG1hZGVfYnk7XG4gICAgICBsZXQgc2VhcmNoX25hbWUgPSBhd2FpdCBnIVxuICAgICAgICAuVihldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgLnZhbHVlcyhcIm5hbWVcIilcbiAgICAgICAgLnRvTGlzdCgpO1xuICAgICAgc3dpdGNoIChldmVudC5hcmd1bWVudHMudmFsdWUpIHtcbiAgICAgICAgY2FzZSBcInBlcnNvblwiOlxuICAgICAgICAgIHVzYWdlID0gYXdhaXQgZ1xuICAgICAgICAgICAgLlYoKVxuICAgICAgICAgICAgLmhhcyhldmVudC5hcmd1bWVudHMudmFsdWUsIFwibmFtZVwiLCBldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgIC5ib3RoRSgpXG4gICAgICAgICAgICAuaGFzTGFiZWwoXCJ1c2FnZVwiKVxuICAgICAgICAgICAgLm90aGVyVigpXG4gICAgICAgICAgICAudmFsdWVzKFwibmFtZVwiKVxuICAgICAgICAgICAgLnRvTGlzdCgpO1xuICAgICAgICAgIGJlbG9uZ190byA9IGF3YWl0IGdcbiAgICAgICAgICAgIC5WKClcbiAgICAgICAgICAgIC5oYXMoZXZlbnQuYXJndW1lbnRzLnZhbHVlLCBcIm5hbWVcIiwgZXZlbnQuYXJndW1lbnRzLm5hbWUpXG4gICAgICAgICAgICAuYm90aEUoKVxuICAgICAgICAgICAgLmhhc0xhYmVsKFwiYmVsb25nX3RvXCIpXG4gICAgICAgICAgICAub3RoZXJWKClcbiAgICAgICAgICAgIC52YWx1ZXMoXCJuYW1lXCIpXG4gICAgICAgICAgICAudG9MaXN0KCk7XG4gICAgICAgICAgYXV0aG9yZWRfYnkgPSBhd2FpdCBnXG4gICAgICAgICAgICAuVigpXG4gICAgICAgICAgICAuaGFzKGV2ZW50LmFyZ3VtZW50cy52YWx1ZSwgXCJuYW1lXCIsIGV2ZW50LmFyZ3VtZW50cy5uYW1lKVxuICAgICAgICAgICAgLmJvdGhFKClcbiAgICAgICAgICAgIC5oYXNMYWJlbChcImF1dGhvcmVkX2J5XCIpXG4gICAgICAgICAgICAub3RoZXJWKClcbiAgICAgICAgICAgIC52YWx1ZXMoXCJuYW1lXCIpXG4gICAgICAgICAgICAudG9MaXN0KCk7XG4gICAgICAgICAgYWZmaWxpYXRlZF93aXRoID0gYXdhaXQgZ1xuICAgICAgICAgICAgLlYoKVxuICAgICAgICAgICAgLmhhcyhldmVudC5hcmd1bWVudHMudmFsdWUsIFwibmFtZVwiLCBldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgIC5ib3RoRSgpXG4gICAgICAgICAgICAuaGFzTGFiZWwoXCJhZmZpbGlhdGVkX3dpdGhcIilcbiAgICAgICAgICAgIC5vdGhlclYoKVxuICAgICAgICAgICAgLnZhbHVlcyhcIm5hbWVcIilcbiAgICAgICAgICAgIC50b0xpc3QoKTtcbiAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgeyBzZWFyY2hfbmFtZSwgdXNhZ2UsIGJlbG9uZ190bywgYXV0aG9yZWRfYnksIGFmZmlsaWF0ZWRfd2l0aCB9LFxuICAgICAgICAgIF07XG4gICAgICAgIGNhc2UgXCJpZFwiOlxuICAgICAgICAgIHVzYWdlID0gYXdhaXQgZ1xuICAgICAgICAgICAgLlYoKVxuICAgICAgICAgICAgLmhhc0lkKGV2ZW50LmFyZ3VtZW50cy5uYW1lKVxuICAgICAgICAgICAgLmJvdGhFKClcbiAgICAgICAgICAgIC5oYXNMYWJlbChcInVzYWdlXCIpXG4gICAgICAgICAgICAub3RoZXJWKClcbiAgICAgICAgICAgIC52YWx1ZXMoXCJuYW1lXCIpXG4gICAgICAgICAgICAudG9MaXN0KCk7XG4gICAgICAgICAgaWYgKGV2ZW50LmFyZ3VtZW50cy5uYW1lLm1hdGNoKC9Eb2MvKSkge1xuICAgICAgICAgICAgYmVsb25nX3RvID0gYXdhaXQgZ1xuICAgICAgICAgICAgICAuVigpXG4gICAgICAgICAgICAgIC5oYXNJZChldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgICAgLmJvdGhFKClcbiAgICAgICAgICAgICAgLmhhc0xhYmVsKFwiYmVsb25nX3RvXCIpXG4gICAgICAgICAgICAgIC5vdGhlclYoKVxuICAgICAgICAgICAgICAudmFsdWVzKFwibmFtZVwiKVxuICAgICAgICAgICAgICAudG9MaXN0KCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGJlbG9uZ190byA9IFtdO1xuICAgICAgICAgIH1cbiAgICAgICAgICBhdXRob3JlZF9ieSA9IGF3YWl0IGdcbiAgICAgICAgICAgIC5WKClcbiAgICAgICAgICAgIC5oYXNJZChldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgIC5ib3RoRSgpXG4gICAgICAgICAgICAuaGFzTGFiZWwoXCJhdXRob3JlZF9ieVwiKVxuICAgICAgICAgICAgLm90aGVyVigpXG4gICAgICAgICAgICAudmFsdWVzKFwibmFtZVwiKVxuICAgICAgICAgICAgLnRvTGlzdCgpO1xuICAgICAgICAgIGFmZmlsaWF0ZWRfd2l0aCA9IGF3YWl0IGdcbiAgICAgICAgICAgIC5WKClcbiAgICAgICAgICAgIC5oYXNJZChldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgIC5ib3RoRSgpXG4gICAgICAgICAgICAuaGFzTGFiZWwoXCJhZmZpbGlhdGVkX3dpdGhcIilcbiAgICAgICAgICAgIC5vdGhlclYoKVxuICAgICAgICAgICAgLnZhbHVlcyhcIm5hbWVcIilcbiAgICAgICAgICAgIC50b0xpc3QoKTtcbiAgICAgICAgICBpZiAoZXZlbnQuYXJndW1lbnRzLm5hbWUubWF0Y2goL1Byb2QvKSkge1xuICAgICAgICAgICAgbWFkZV9ieSA9IGF3YWl0IGdcbiAgICAgICAgICAgICAgLlYoKVxuICAgICAgICAgICAgICAuaGFzSWQoZXZlbnQuYXJndW1lbnRzLm5hbWUpXG4gICAgICAgICAgICAgIC5vdXQoXCJtYWRlX2J5XCIpXG4gICAgICAgICAgICAgIC52YWx1ZXMoXCJuYW1lXCIpXG4gICAgICAgICAgICAgIC50b0xpc3QoKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbWFkZV9ieSA9IFtdO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZXZlbnQuYXJndW1lbnRzLm5hbWUubWF0Y2goL0NvbmYvKSkge1xuICAgICAgICAgICAgcGVvcGxlID0gYXdhaXQgZ1xuICAgICAgICAgICAgICAuVigpXG4gICAgICAgICAgICAgIC5oYXNJZChldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgICAgLmluXygpXG4gICAgICAgICAgICAgIC52YWx1ZXMoXCJuYW1lXCIpXG4gICAgICAgICAgICAgIC50b0xpc3QoKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGVvcGxlID0gW107XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChldmVudC5hcmd1bWVudHMubmFtZS5tYXRjaCgvSW5zdC8pKSB7XG4gICAgICAgICAgICBhZmZpbGlhdGVkX3dpdGggPSBbXTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc2VhcmNoX25hbWUsXG4gICAgICAgICAgICAgIHVzYWdlLFxuICAgICAgICAgICAgICBiZWxvbmdfdG8sXG4gICAgICAgICAgICAgIGF1dGhvcmVkX2J5LFxuICAgICAgICAgICAgICBhZmZpbGlhdGVkX3dpdGgsXG4gICAgICAgICAgICAgIG1hZGVfYnksXG4gICAgICAgICAgICAgIHBlb3BsZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXTtcbiAgICAgICAgY2FzZSBcInByb2R1Y3RcIjpcbiAgICAgICAgICBjb25zb2xlLmxvZyhldmVudC5hcmd1bWVudHMpO1xuICAgICAgICAgIG1hZGVfYnkgPSBhd2FpdCBnXG4gICAgICAgICAgICAuVigpXG4gICAgICAgICAgICAuaGFzKGV2ZW50LmFyZ3VtZW50cy52YWx1ZSwgXCJuYW1lXCIsIGV2ZW50LmFyZ3VtZW50cy5uYW1lKVxuICAgICAgICAgICAgLm91dChcIm1hZGVfYnlcIilcbiAgICAgICAgICAgIC52YWx1ZXMoXCJuYW1lXCIpXG4gICAgICAgICAgICAudG9MaXN0KCk7XG4gICAgICAgICAgcmV0dXJuIFt7IHNlYXJjaF9uYW1lLCBtYWRlX2J5IH1dO1xuICAgICAgICBjYXNlIFwiY29uZmVyZW5jZVwiOlxuICAgICAgICAgIGNvbnNvbGUubG9nKGV2ZW50LmFyZ3VtZW50cyk7XG4gICAgICAgICAgcGVvcGxlID0gYXdhaXQgZ1xuICAgICAgICAgICAgLlYoKVxuICAgICAgICAgICAgLmhhcyhldmVudC5hcmd1bWVudHMudmFsdWUsIFwibmFtZVwiLCBldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgIC5pbl8oKVxuICAgICAgICAgICAgLnZhbHVlcyhcIm5hbWVcIilcbiAgICAgICAgICAgIC50b0xpc3QoKTtcbiAgICAgICAgICByZXR1cm4gW3sgc2VhcmNoX25hbWUsIHBlb3BsZSB9XTtcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBjb25zb2xlLmxvZyhcImRlZmF1bHRcIik7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0eXBlID09PSBcInJlbGF0aW9uXCIpIHtcbiAgICAgIHN3aXRjaCAoZXZlbnQuYXJndW1lbnRzLnZhbHVlKSB7XG4gICAgICAgIGNhc2UgXCJwZXJzb25cIjpcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBnXG4gICAgICAgICAgICAuVigpXG4gICAgICAgICAgICAuaGFzKGV2ZW50LmFyZ3VtZW50cy52YWx1ZSwgXCJuYW1lXCIsIGV2ZW50LmFyZ3VtZW50cy5uYW1lKVxuICAgICAgICAgICAgLmFzKGV2ZW50LmFyZ3VtZW50cy52YWx1ZSlcbiAgICAgICAgICAgIC5vdXQoXCJiZWxvbmdfdG9cIilcbiAgICAgICAgICAgIC5pbl8oKVxuICAgICAgICAgICAgLndoZXJlKFAubmVxKGV2ZW50LmFyZ3VtZW50cy52YWx1ZSkpXG4gICAgICAgICAgICAudmFsdWVzKFwibmFtZVwiKVxuICAgICAgICAgICAgLmRlZHVwKClcbiAgICAgICAgICAgIC50b0xpc3QoKTtcbiAgICAgICAgICByZXR1cm4gcmVzdWx0Lm1hcCgocjogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4geyBuYW1lOiByIH07XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgY2FzZSBcInByb2R1Y3RcIjpcbiAgICAgICAgICBjb25zdCByZXN1bHQyID0gYXdhaXQgZ1xuICAgICAgICAgICAgLlYoKVxuICAgICAgICAgICAgLmhhcyhldmVudC5hcmd1bWVudHMudmFsdWUsIFwibmFtZVwiLCBldmVudC5hcmd1bWVudHMubmFtZSlcbiAgICAgICAgICAgIC5hcyhldmVudC5hcmd1bWVudHMudmFsdWUpXG4gICAgICAgICAgICAuaW5fKFwidXNhZ2VcIilcbiAgICAgICAgICAgIC5hcyhcInBcIilcbiAgICAgICAgICAgIC5pbl8oXCJhdXRob3JlZF9ieVwiKVxuICAgICAgICAgICAgLm91dCgpXG4gICAgICAgICAgICAud2hlcmUoUC5uZXEoXCJwXCIpKVxuICAgICAgICAgICAgLnZhbHVlcyhcIm5hbWVcIilcbiAgICAgICAgICAgIC5kZWR1cCgpXG4gICAgICAgICAgICAudG9MaXN0KCk7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdDIubWFwKChyOiBzdHJpbmcpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB7IG5hbWU6IHIgfTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgY2FzZSBcImNvbmZlcmVuY2VcIjpcbiAgICAgICAgICBjb25zb2xlLmxvZyhldmVudC5hcmd1bWVudHMpO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdDMgPSBhd2FpdCBnXG4gICAgICAgICAgICAuVigpXG4gICAgICAgICAgICAuaGFzKGV2ZW50LmFyZ3VtZW50cy52YWx1ZSwgXCJuYW1lXCIsIGV2ZW50LmFyZ3VtZW50cy5uYW1lKVxuICAgICAgICAgICAgLmFzKGV2ZW50LmFyZ3VtZW50cy52YWx1ZSlcbiAgICAgICAgICAgIC5pbl8oKVxuICAgICAgICAgICAgLmFzKFwicFwiKVxuICAgICAgICAgICAgLm91dCgpXG4gICAgICAgICAgICAuaGFzTGFiZWwoXCJwZXJzb25cIilcbiAgICAgICAgICAgIC53aGVyZShQLm5lcShcInBcIikpXG4gICAgICAgICAgICAudmFsdWVzKFwibmFtZVwiKVxuICAgICAgICAgICAgLmRlZHVwKClcbiAgICAgICAgICAgIC50b0xpc3QoKTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhyZXN1bHQzKTtcbiAgICAgICAgICByZXR1cm4gcmVzdWx0My5tYXAoKHI6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHsgbmFtZTogciB9O1xuICAgICAgICAgIH0pO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIGNvbnNvbGUubG9nKFwiZGVmYXVsdFwiKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZy5WKCkudG9MaXN0KCk7XG4gICAgICBjb25zdCB2ZXJ0ZXggPSByZXN1bHQubWFwKChyOiBhbnkpID0+IHtcbiAgICAgICAgcmV0dXJuIHsgaWQ6IHIuaWQsIGxhYmVsOiByLmxhYmVsIH07XG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHJlc3VsdDIgPSBhd2FpdCBnLkUoKS50b0xpc3QoKTtcbiAgICAgIGNvbnN0IGVkZ2UgPSByZXN1bHQyLm1hcCgocjogYW55KSA9PiB7XG4gICAgICAgIGNvbnNvbGUubG9nKHIpO1xuICAgICAgICByZXR1cm4geyBzb3VyY2U6IHIub3V0Vi5pZCwgdGFyZ2V0OiByLmluVi5pZCwgdmFsdWU6IHIubGFiZWwgfTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHsgbm9kZXM6IHZlcnRleCwgbGlua3M6IGVkZ2UgfTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBjb25zb2xlLmxvZyhlcnJvcik7XG4gICAgY29uc29sZS5lcnJvcihKU09OLnN0cmluZ2lmeShlcnJvcikpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59O1xuIl19