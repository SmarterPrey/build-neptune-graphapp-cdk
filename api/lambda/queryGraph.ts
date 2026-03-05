import { Handler } from "aws-lambda";

import * as gremlin from "gremlin";
import { getUrlAndHeaders } from "gremlin-aws-sigv4/lib/utils";

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const P = gremlin.process.P;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const TextP = gremlin.process.TextP;
export const handler: Handler = async (event) => {
  let conn = null;
  const getConnectionDetails = () => {
    return getUrlAndHeaders(
      process.env.NEPTUNE_ENDPOINT,
      process.env.NEPTUNE_PORT,
      {},
      "/gremlin",
      "wss"
    );
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
    const searchConfig: Record<string, { label: string; fields: string[]; entityType?: string }> = {
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
      if (!cfg) throw new Error(`Unknown vertex type: ${vertexType}`);

      let searchQuery = g!.V().hasLabel(cfg.label);
      if (cfg.entityType) {
        searchQuery = searchQuery.has('entityTypes', cfg.entityType);
      }

      // Only apply text filter if searchValue is non-empty
      const trimmed = (searchValue || '').trim();
      if (trimmed && trimmed !== '*') {
        if (cfg.fields.length === 1) {
          searchQuery = searchQuery.has(cfg.fields[0], TextP.containing(trimmed));
        } else {
          searchQuery = searchQuery.or(
            ...cfg.fields.map((f: string) => __.has(f, TextP.containing(trimmed)))
          );
        }
      }

      const results = await searchQuery
        .project('id', 'name', 'label', 'entityType')
        .by(__.id())
        .by(__.coalesce(
          __.values('companyName'),
          __.values('name'),
          __.values('jobName'),
          __.values('partName'),
          __.values('make'),
          __.constant('Unknown')
        ))
        .by(__.label())
        .by(__.coalesce(__.values('entityTypes'), __.constant('')))
        .limit(50)
        .toList();

      return results.map((r: any) => ({
        id: r.id ?? (r.get ? r.get('id') : undefined),
        name: r.name ?? (r.get ? r.get('name') : undefined),
        label: r.label ?? (r.get ? r.get('label') : undefined),
        entityType: r.entityType || (r.get ? r.get('entityType') : null) || null,
      }));
    }

    if (event.field === "searchProjects") {
      const { searchValue } = event.arguments;
      const trimmed = (searchValue || '').trim();

      let searchQuery = g!.V().hasLabel('Project_Data');
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

      return results.map((r: any) => ({
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
      if (!cfg) throw new Error(`Unknown vertex type: ${vertexType}`);

      let vertexId = directVertexId;
      if (!vertexId) {
        let searchQuery = g!.V().hasLabel(cfg.label);
        if (cfg.entityType) {
          searchQuery = searchQuery.has('entityTypes', cfg.entityType);
        }
        const trimmedSv = (searchValue || '').trim();
        if (trimmedSv && trimmedSv !== '*') {
          if (cfg.fields.length === 1) {
            searchQuery = searchQuery.has(cfg.fields[0], TextP.containing(trimmedSv));
          } else {
            searchQuery = searchQuery.or(
              ...cfg.fields.map((f: string) => __.has(f, TextP.containing(trimmedSv)))
            );
          }
        }
        const vertexIds = await searchQuery.id().limit(1).toList();
        if (vertexIds.length === 0) return [];
        vertexId = vertexIds[0];
      }

      if (event.field === "getEntityProperties") {
        const result = await g!.V(vertexId).valueMap().toList();
        if (result.length === 0) return [];
        const vertexMap = result[0];
        const properties: Array<{ key: string; value: string }> = [];
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
        const outEdges = await g!.V(vertexId)
          .outE()
          .project('edgeLabel', 'targetLabel', 'targetName')
          .by(__.label())
          .by(__.inV().label())
          .by(__.inV().coalesce(
            __.values('companyName'),
            __.values('name'),
            __.values('jobName'),
            __.values('partName'),
            __.values('make'),
            __.constant('Unknown')
          ))
          .toList();

        const inEdges = await g!.V(vertexId)
          .inE()
          .project('edgeLabel', 'targetLabel', 'targetName')
          .by(__.label())
          .by(__.outV().label())
          .by(__.outV().coalesce(
            __.values('companyName'),
            __.values('name'),
            __.values('jobName'),
            __.values('partName'),
            __.values('make'),
            __.constant('Unknown')
          ))
          .toList();

        const edges: Array<{ edgeLabel: string; direction: string; targetLabel: string; targetName: string }> = [];
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
      let search_name = await g!
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
          } else {
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
          } else {
            made_by = [];
          }
          if (event.arguments.name.match(/Conf/)) {
            people = await g
              .V()
              .hasId(event.arguments.name)
              .in_()
              .values("name")
              .toList();
          } else {
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
    } else if (type === "relation") {
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
          return result.map((r: string) => {
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
          return result2.map((r: string) => {
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
          return result3.map((r: string) => {
            return { name: r };
          });
        default:
          console.log("default");
      }
    } else {
      const result = await g.V().toList();
      const vertex = result.map((r: any) => {
        return { id: r.id, label: r.label };
      });
      const result2 = await g.E().toList();
      const edge = result2.map((r: any) => {
        console.log(r);
        return { source: r.outV.id, target: r.inV.id, value: r.label };
      });
      return { nodes: vertex, links: edge };
    }
  } catch (error: any) {
    console.log(error);
    console.error(JSON.stringify(error));
    throw error;
  }
};
