import { getGraph, getProfile, getRelationName, askGraph, getEntityProperties, getEntityEdges, searchEntities, searchProjects } from "@/api/appsync/query";
import {
  GetGraphQuery,
  GetRelationNameQuery,
  GetProfileQuery,
  AskGraphQuery,
  GetEntityPropertiesQuery,
  GetEntityEdgesQuery,
  SearchEntitiesQuery,
  SearchProjectsQuery,
} from "@/types/types";
import { GraphQLResult, generateClient } from "aws-amplify/api";
import { type ClassValue, clsx } from "clsx";
import { Loader2 } from "lucide-react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const Icons = {
  spinner: Loader2,
};

export const queryGetProfile = async (name: string, value: string) => {
  const client = generateClient();
  const res = (await client.graphql({
    query: getProfile,
    variables: {
      type: "profile",
      value,
      name,
    },
  })) as GraphQLResult<GetProfileQuery>;
  return res;
};

export const queryGetRelationName = async (name: string, value: string) => {
  const client = generateClient();
  const res = (await client.graphql({
    query: getRelationName,
    variables: {
      type: "relation",
      value,
      name: name,
    },
  })) as GraphQLResult<GetRelationNameQuery>;
  return res;
};

export const queryGetGraph = async (value: string) => {
  const client = generateClient();
  const res = (await client.graphql({
    query: getGraph,
    variables: {
      type: "graph",
      value,
    },
  })) as GraphQLResult<GetGraphQuery>;
  return res;
};

export const queryAskGraph = async (
  question: string,
  history?: string
) => {
  const client = generateClient();
  const res = (await client.graphql({
    query: askGraph,
    variables: {
      question,
      history: history || null,
    },
  })) as GraphQLResult<AskGraphQuery>;
  return res;
};

export const queryEntityProperties = async (vertexType: string, searchValue?: string, vertexId?: string) => {
  const client = generateClient();
  const res = (await client.graphql({
    query: getEntityProperties,
    variables: { vertexType, searchValue: searchValue || null, vertexId: vertexId || null },
  })) as GraphQLResult<GetEntityPropertiesQuery>;
  return res;
};

export const queryEntityEdges = async (vertexType: string, searchValue?: string, vertexId?: string) => {
  const client = generateClient();
  const res = (await client.graphql({
    query: getEntityEdges,
    variables: { vertexType, searchValue: searchValue || null, vertexId: vertexId || null },
  })) as GraphQLResult<GetEntityEdgesQuery>;
  return res;
};

export const querySearchEntities = async (vertexType: string, searchValue?: string) => {
  const client = generateClient();
  const res = (await client.graphql({
    query: searchEntities,
    variables: { vertexType, searchValue: searchValue || null },
  })) as GraphQLResult<SearchEntitiesQuery>;
  return res;
};

export const querySearchProjects = async (searchValue?: string) => {
  return (await generateClient().graphql({
    query: searchProjects,
    variables: { searchValue: searchValue ?? '' },
  })) as GraphQLResult<SearchProjectsQuery>;
};
