import {
  AccountInfo,
  AuthenticateCustomerPayload,
  FunctionInfo,
  FunctionLog,
  PAT,
  Project,
  ProjectDefinition,
  ProjectInfo,
  RemoteProject,
  SimpleProjectInfo,
} from '../types/common'

import { GraphQLClient, request } from 'graphql-request'
import { omit, flatMap } from 'lodash'
import { Config } from '../Config'
import { getFastestRegion } from './ping'
import { Environment, Cluster } from 'graphcool-yml'
import { Output } from '../index'
import chalk from 'chalk'
import { DeployPayload } from './clientTypes'
import { introspectionQuery } from './introspectionQuery'

const debug = require('debug')('client')

const REMOTE_PROJECT_FRAGMENT = `
  fragment RemoteProject on Project {
    id
    name
    schema
    alias
    region
    isEjected
    projectDefinitionWithFileContent
  }
`

const MIGRATION_FRAGMENT = `
fragment MigrationFragment on Migration {
  revision
  steps {
    type
    __typename
    ... on CreateEnum {
      name
      ce_values: values
    }
    ... on CreateField {
      model
      name
      cf_typeName: typeName
      cf_isRequired: isRequired
      cf_isList: isList
      cf_isUnique: unique
      cf_relation: relation
      cf_defaultValue: default
      cf_enum: enum
    }
    ... on CreateModel {
      name
    }
    ... on CreateRelation {
      name
      leftModel
      rightModel
    }
    ... on DeleteEnum {
      name
    }
    ... on DeleteField {
      model
      name
    }
    ... on DeleteModel {
      name
    }
    ... on DeleteRelation {
      name
    }
    ... on UpdateEnum {
      name
      newName
      values
    }
    ... on UpdateField {
      model
      name
      newName
      typeName
      isRequired
      isList
      isUnique: unique
      relation
      default
      enum
    }
    ... on UpdateModel {
      name
      um_newName: newName
    }
  }
  hasBeenApplied
}
`

export class Client {
  config: Config
  env: Environment
  out: Output
  public mock: (input: { request: any; response: any }) => void

  private mocks: { [request: string]: string } = {}
  private tokenCache: string

  constructor(config: Config, environment: Environment, out: Output) {
    this.config = config
    this.env = environment
    this.out = out
  }

  // always create a new client which points to the latest config for each request
  getClient(cluster: Cluster) {
    return new GraphQLClient(cluster.getDeployEndpoint(), {
      headers: {
        Authorization: `Bearer ${cluster.token}`,
      },
    })
  }
  get client(): GraphQLClient {
    debug(
      'choosing clusterEndpoint',
      this.env.activeCluster.getDeployEndpoint(),
    )
    const localClient = this.getClient(this.env.activeCluster!)
    return {
      request: async (query, variables) => {
        debug('Sending query')
        debug(query)
        debug(variables)
        try {
          return await localClient.request(query, variables)
        } catch (e) {
          if (e.message.includes('No service with id')) {
            // const user = await this.getAccount()
            const message = e.response.errors[0].message
            this.out.error(
              message +
                ` Please check if you are logged in to the right account.`,
            )
          } else if (e.message.startsWith('No valid session')) {
            // await this.auth.ensureAuth(true)
            // try again with new token
            return await this.client.request(query, variables)
          } else if (
            e.message.includes('ECONNREFUSED') &&
            (e.message.includes('localhost') || e.message.includes('127.0.0.1'))
          ) {
            this.out.error(
              `Could not connect to local cluster. Please use ${chalk.bold.green(
                'graphcool local up',
              )} to start your local Graphcool cluster.`,
            )
          } else {
            throw e
          }
        }
      },
    } as any
  }

  // async getAccount(): Promise<AccountInfo> {
  //   const { viewer: { user } } = await this.client.request<{
  //     viewer: { user: AccountInfo }
  //   }>(`{
  //     viewer {
  //       user {
  //         email
  //         name
  //       }
  //     }
  //   }`)

  //   return user
  // }

  async introspect(
    serviceName: string,
    stageName: string,
    token?: string,
  ): Promise<any> {
    debug('introspecting', serviceName, stageName, token)
    const headers: any = {}
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    const client = new GraphQLClient(
      this.env.activeCluster.getApiEndpoint(serviceName, stageName),
      {
        headers,
      },
    )
    return client.request(introspectionQuery)
  }

  async download(
    serviceName: string,
    stage: string,
    exportData: any,
    token?: string,
  ): Promise<any> {
    const endpoint = this.env.activeCluster.getExportEndpoint(
      serviceName,
      stage,
    )
    debug(`Downloading from ${endpoint}`)
    debug(exportData)
    const result = await fetch(endpoint, {
      method: 'post',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: exportData,
    })

    const text = await result.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error(text)
    }
  }

  async upload(
    serviceName: string,
    stage: string,
    exportData: any,
    token?: string,
  ): Promise<any> {
    const result = await fetch(
      this.env.activeCluster.getImportEndpoint(serviceName, stage),
      {
        method: 'post',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: exportData,
      },
    )

    const text = await result.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error(text)
    }
  }

  async reset(
    serviceName: string,
    stage: string,
    token?: string,
  ): Promise<void> {
    const result = await fetch(
      this.env.activeCluster.getApiEndpoint(serviceName, stage),
      {
        method: 'post',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation {
          resetData
        }`,
        }),
      },
    )

    const text = await result.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error(text)
    }
  }

  async addProject(
    name: string,
    stage: string,
    secrets: string[] | null,
  ): Promise<SimpleProjectInfo> {
    const mutation = `\
      mutation addProject($name: String! $stage: String! $secrets: [String!]) {
        addProject(input: {
          name: $name,
          stage: $stage
          secrets: $secrets
        }) {
          project {
            name
          }
        }
      }
      `

    const { addProject: { project } } = await this.client.request<{
      addProject: { project: SimpleProjectInfo }
    }>(mutation, {
      name,
      stage,
      secrets,
    })

    // TODO set project definition, should be possibility in the addProject mutation

    return project
  }

  async getDeployUrl(projectId: string): Promise<string> {
    const mutation = `
      mutation getUrl($projectId: String!) {
        getTemporaryDeployUrl(
          input: {
          projectId: $projectId
        }
      ) {
          url
        }
      }
    `

    const { getTemporaryDeployUrl: { url } } = await this.client.request<{
      getTemporaryDeployUrl: { url: string }
    }>(mutation, { projectId })
    return url
  }

  async deploy(
    name: string,
    stage: string,
    types: string,
    dryRun: boolean,
    secrets: string[] | null,
  ): Promise<any> {
    // TODO add dryRun to query as soon as the backend is ready
    const mutation = `\
      mutation($name: String!, $stage: String! $types: String! $dryRun: Boolean $secrets: [String!]) {
        deploy(input: {
          name: $name
          stage: $stage
          types: $types
          dryRun: $dryRun
          secrets: $secrets
        }) {
          errors {
            type
            field
            description
          }
          migration {
            ...MigrationFragment
          }
        }
      }
      ${MIGRATION_FRAGMENT}
    `
    const { deploy } = await this.client.request<{
      deploy: DeployPayload
    }>(mutation, {
      name,
      stage,
      types,
      dryRun,
      secrets,
    })

    return deploy
  }

  async listProjects(): Promise<Project[]> {
    const { listProjects } = await this.client.request<{
      listProjects: Project[]
    }>(`
      {
        listProjects {
          name
          stage
        }
      }
    `)

    return listProjects
  }

  async getCluster(name: string, stage: string): Promise<Cluster | null> {
    const foundClusters: Cluster[] = []
    for (const cluster of this.env.clusters) {
      const client = this.getClient(cluster)
      try {
        const { project } = await client.request<{
          project: Project
        }>(
          `
            query ($name: String! $stage: String!) {
              project (name: $name stage: $stage) {
                name
                stage
              }
            }
          `,
          {
            name,
            stage,
          },
        )

        if (project) {
          foundClusters.push(cluster)
        }
      } catch (e) {
        //
      }
    }

    if (foundClusters.length === 1) {
      return foundClusters[0]
    }

    if (foundClusters.length > 1) {
      const clusterNames = foundClusters.map(c => c.name).join(', ')
      throw new Error(
        `The service name / stage combination "${name}@${stage}" is ambigious. It exists in clusters ${clusterNames}`,
      )
    }

    return null
  }

  async getClusterSafe(name: string, stage: string): Promise<Cluster> {
    const cluster = await this.getCluster(name, stage)
    if (!cluster) {
      throw new Error(
        `No cluster for "${name}@${stage}" found. Please make sure to deploy the stage ${stage}`,
      )
    }

    return cluster
  }

  async waitForLocalDocker(endpoint: string): Promise<void> {
    // dont send any auth information when running the authenticateCustomer mutation
    let valid = false
    while (!valid) {
      try {
        debug('requesting', endpoint)
        await request(
          endpoint,
          `
            {
              __schema {
                directives {
                  description
                }
              }
            }
            `,
        )
        valid = true
      } catch (e) {
        debug(e)
        valid = false
      }

      await new Promise(r => setTimeout(r, 500))
    }
  }

  async waitForMigration(
    name: string,
    stage: string,
    revision: number,
  ): Promise<void> {
    while (true) {
      const { migrationStatus } = await this.client.request<any>(
        `query ($name: String! $stage: String!) {
              migrationStatus(name: $name stage: $stage) {
                revision
                hasBeenApplied
              }
            }
        `,

        {
          stage,
          name,
        },
      )

      if (
        migrationStatus.revision >= revision &&
        migrationStatus.hasBeenApplied
      ) {
        return
      }

      await new Promise(r => setTimeout(r, 500))
    }
  }

  async authenticateCustomer(
    endpoint: string,
    token: string,
  ): Promise<AuthenticateCustomerPayload> {
    // dont send any auth information when running the authenticateCustomer mutation
    const result = await request<{
      authenticateCustomer: AuthenticateCustomerPayload
    }>(
      endpoint,
      `
      mutation ($token: String!) {
        authenticateCustomer(input: {
          auth0IdToken: $token
        }) {
          token
          user {
            id
          }
        }
      }
      `,
      { token },
    )

    return result.authenticateCustomer
  }

  async getPats(projectId: string): Promise<PAT[]> {
    interface ProjectPatPayload {
      viewer: {
        project: {
          permanentAuthTokens: {
            edges: Array<{
              node: PAT
            }>
          }
        }
      }
    }
    const {
      viewer: { project: { permanentAuthTokens } },
    } = await this.client.request<ProjectPatPayload>(
      `
      query ($projectId: ID!){
        viewer {
          project(id: $projectId) {
            permanentAuthTokens {
              edges {
                node {
                  id
                  name
                  token
                }
              }
            }
          }
        }
      }
      `,
      { projectId },
    )

    if (!permanentAuthTokens) {
      return []
    }

    return permanentAuthTokens.edges.map(edge => edge.node)
  }

  async getFunctions(projectId: string): Promise<FunctionInfo[]> {
    interface FunctionsPayload {
      viewer: {
        project: {
          functions: {
            edges: Array<{
              node: FunctionInfo
            }>
          }
        }
      }
    }
    const { viewer: { project: { functions } } } = await this.client.request<
      FunctionsPayload
    >(
      `
      query ($projectId: ID!){
        viewer {
          project(id: $projectId) {
            functions {
              edges {
                node {
                  name
                  id
                  type
                  stats {
                    requestCount
                    errorCount
                  }
                  __typename
                }
              }
            }
          }
        }
      }
      `,
      { projectId },
    )

    return functions.edges.map(edge => edge.node)
  }

  async getFunction(
    projectId: string,
    functionName: string,
  ): Promise<FunctionInfo | null> {
    const functions = await this.getFunctions(projectId)
    const normalizedFunctionName = normalizeName(functionName)
    return (
      functions.find(fn => normalizeName(fn.name) === normalizedFunctionName) ||
      null
    )
  }

  async getFunctionLogs(
    functionId: string,
    count: number = 1000,
  ): Promise<FunctionLog[] | null> {
    interface FunctionLogsPayload {
      node: {
        logs: {
          pageInfo: {
            endCursor: string
          }
          edges: Array<{
            node: FunctionLog
          }>
        }
      }
    }

    const { node } = await this.client.request<FunctionLogsPayload>(
      `query ($id: ID!, $count: Int!) {
      node(id: $id) {
        ... on Function {
          logs(last: $count) {
            pageInfo {
              endCursor
            }
            edges {
              node {
                id
                requestId
                duration
                status
                timestamp
                message
              }
            }
          }
        }
      }
    }`,
      { id: functionId, count },
    )

    return node && node.logs ? node.logs.edges.map(edge => edge.node) : null
  }

  async getAllFunctionLogs(
    projectId: string,
    count: number = 1000,
  ): Promise<FunctionLog[] | null> {
    interface AllFunctionLogsPayload {
      viewer: {
        project: {
          functions: {
            edges: Array<{
              node: {
                logs: {
                  edges: Array<{
                    node: FunctionLog
                  }>
                }
              }
            }>
          }
        }
      }
    }

    const { viewer: { project } } = await this.client.request<
      AllFunctionLogsPayload
    >(
      `
        query ($id: ID!, $count: Int!) {
          viewer {
            project(id: $id) {
              functions {
                edges {
                  node {
                    logs(last: $count) {
                      edges {
                        node {
                          id
                          requestId
                          duration
                          status
                          timestamp
                          message
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        `,
      { id: projectId, count },
    )

    return project && project.functions && project.functions.edges
      ? flatMap(
          project.functions.edges.map(functionEdge =>
            functionEdge.node.logs.edges.map(logEdge => logEdge.node),
          ),
        )
      : null
  }

  async getProjectName(projectId: string): Promise<string> {
    interface ProjectInfoPayload {
      viewer: {
        project: {
          name: string
        }
      }
    }

    const { viewer: { project } } = await this.client.request<
      ProjectInfoPayload
    >(
      `
      query ($projectId: ID!){
        viewer {
          project(id: $projectId) {
            name
          }
        }
      }
      `,
      { projectId },
    )

    return project.name
  }

  async deleteProjects(projectIds: string[]): Promise<string[]> {
    const inputArguments = projectIds.reduce((prev, current, index) => {
      return `${prev}$projectId${index}: String!${
        index < projectIds.length - 1 ? ', ' : ''
      }`
    }, '')
    const singleMutations = projectIds.map(
      (projectId, index) => `
      ${projectId}: deleteProject(input:{
          projectId: $projectId${index},
          clientMutationId: "asd"
        }) {
          deletedId
      }`,
    )

    const header = `mutation (${inputArguments}) `
    const body = singleMutations.join('\n')
    const mutation = `${header} { \n${body} \n}`
    const variables = projectIds.reduce((prev, current, index) => {
      prev[`projectId${index}`] = current
      return prev
    }, {})

    interface DeletePayload {
      [projectId: string]: {
        deletedId: string
      }
    }

    const result = await this.client.request<DeletePayload>(mutation, variables)

    return Object.keys(result).map(projectId => result[projectId].deletedId)
  }

  async exportProjectData(projectId: string): Promise<string> {
    interface ExportPayload {
      exportData: {
        url: string
      }
    }

    const { exportData } = await this.client.request<ExportPayload>(
      `
      mutation ($projectId: String!){
        exportData(input:{
          projectId: $projectId,
          clientMutationId: "asd"
        }) {
          url
        }
      }
    `,
      { projectId },
    )

    return exportData.url
  }
}

// only make this available in test mode
// if (process.env.NODE_ENV === 'test') {
//   Client.prototype.mock = function({ request, response }) {
//     if (!this.mocks) {
//       this.mocks = {}
//     }
//     this.mocks[JSON.stringify(request, null, 2)] = response
//   }
// }

function normalizeName(name: string) {
  return name.toLowerCase().trim()
}
