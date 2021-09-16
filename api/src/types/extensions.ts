import { Router } from 'express';
import { Knex } from 'knex';
import { Logger } from 'pino';
import env from '../env';
import * as exceptions from '../exceptions';
import * as services from '../services';
import { getSchema } from '../utils/get-schema';

export type ExtensionContext = {
	services: typeof services;
	exceptions: typeof exceptions;
	database: Knex;
	env: typeof env;
	logger: Logger;
	getSchema: typeof getSchema;
};

export type FilterOptions = {
	order?: number;
};

export type FilterHandler = {
	(data?: Record<string, any>): any | Promise<any>;
	order?: number;
};

export type ActionHandler = (data?: Record<string, any>) => void | Promise<void>;
export type InitHandler = (data?: Record<string, any>) => void | Promise<void>;
export type ScheduleHandler = () => void | Promise<void>;

type RegisterFunctions = {
	filter: (event: string, handler: FilterHandler) => void;
	action: (event: string, handler: ActionHandler) => void;
	init: (event: string, handler: InitHandler) => void;
	schedule: (cron: string, handler: ScheduleHandler) => void;
};

type HookHandlerFunction = (register: RegisterFunctions, context: ExtensionContext) => void;

export type HookConfig = HookHandlerFunction;

type EndpointHandlerFunction = (router: Router, context: ExtensionContext) => void;
interface EndpointAdvancedConfig {
	id: string;
	handler: EndpointHandlerFunction;
}

export type EndpointConfig = EndpointHandlerFunction | EndpointAdvancedConfig;
