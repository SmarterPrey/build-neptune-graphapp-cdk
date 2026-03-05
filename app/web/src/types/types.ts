export type ErrorMessage = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message?: any;
};

export type FieldDefinition = {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  required?: boolean;
  options?: string[];
  placeholder?: string;
};

export type VertexTypeItem = {
  value: string;
  description: string;
  fields: FieldDefinition[];
};

export type EdgeTypeItem = {
  value: string;
  description: string;
  sourceLabel: string;
  destLabel: string;
  fields: FieldDefinition[];
};

export type Result = {
  name: string;
};

export type EntityProperty = {
  key: string;
  value: string;
};

export type EdgeRelation = {
  edgeLabel: string;
  direction: string;
  targetLabel: string;
  targetName: string;
};

export type GetEntityPropertiesQuery = {
  getEntityProperties: EntityProperty[];
};

export type GetEntityEdgesQuery = {
  getEntityEdges: EdgeRelation[];
};

export type SearchResult = {
  id: string;
  name: string;
  label: string;
  entityType: string | null;
};

export type SearchEntitiesQuery = {
  searchEntities: SearchResult[];
};

export type InsertDataInput = {
  value: string;
  name?: string;
  edge?: string;
  vertex?: string;
  property?: string;
  source?: string;
  sourceLabel?: string;
  destination?: string;
  destLabel?: string;
  properties?: string;
};

export type Graph = {
  value: string;
  description: string;
  data: string;
};

export type GetRelationNameQuery = {
  getRelationName: Array<{
    name: string;
  }>;
};

export type GetProfileQuery = {
  getProfile: Array<{
    search_name: string;
    usage?: string;
    belong_to?: string;
    authored_by?: string;
    affiliated_with?: string;
    people?: string;
    made_by?: string;
  }>;
};

export type GetGraphQuery = {
  getGraph: {
    nodes: Array<{
      id: string;
      label: string;
    }>;
    links: Array<{
      source: string;
      target: string;
      value: string;
    }>;
  };
};

export type AskGraphQuery = {
  askGraph: {
    answer: string;
    query: string | null;
    data: string | null;
  };
};

export interface ProjectData {
  id: string;
  projectName: string;
  DepartmentNumber?: string;
  DataClassification?: string;
  Team?: string;
  OwnerGroup?: string;
  Recovery?: string;
  Tier?: string;
}

export type SearchProjectsQuery = {
  searchProjects: ProjectData[];
};
