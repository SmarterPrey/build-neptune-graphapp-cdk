export const getRelationName = /* GraphQL */ `
  query getRelationName($type: String!, $name: String!, $value: String!) {
    getRelationName(type: $type, name: $name, value: $value) {
      name
    }
  }
`;

export const getProfile = /* GraphQL */ `
  query getProfile($type: String!, $name: String!, $value: String!) {
    getProfile(type: $type, name: $name, value: $value) {
      search_name
      usage
      belong_to
      authored_by
      affiliated_with
      people
      made_by
    }
  }
`;
export const getGraph = /* GraphQL */ `
  query getGraph($type: String!, $value: String!) {
    getGraph(type: $type, value: $value) {
      nodes {
        id
        label
      }
      links {
        source
        target
        value
      }
    }
  }
`;

export const askGraph = /* GraphQL */ `
  query askGraph($question: String!, $history: String) {
    askGraph(question: $question, history: $history) {
      answer
      query
      data
    }
  }
`;

export const getEntityProperties = /* GraphQL */ `
  query getEntityProperties($vertexType: String!, $searchValue: String, $vertexId: String) {
    getEntityProperties(vertexType: $vertexType, searchValue: $searchValue, vertexId: $vertexId) {
      key
      value
    }
  }
`;

export const getEntityEdges = /* GraphQL */ `
  query getEntityEdges($vertexType: String!, $searchValue: String, $vertexId: String) {
    getEntityEdges(vertexType: $vertexType, searchValue: $searchValue, vertexId: $vertexId) {
      edgeLabel
      direction
      targetLabel
      targetName
    }
  }
`;

export const searchEntities = /* GraphQL */ `
  query searchEntities($vertexType: String!, $searchValue: String) {
    searchEntities(vertexType: $vertexType, searchValue: $searchValue) {
      id
      name
      label
      entityType
    }
  }
`;

export const searchProjects = /* GraphQL */ `
  query searchProjects($searchValue: String) {
    searchProjects(searchValue: $searchValue) {
      id
      projectName
      DepartmentNumber
      DataClassification
      Team
      OwnerGroup
      Recovery
      Tier
    }
  }
`;
