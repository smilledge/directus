import { Knex } from 'knex';
import { HelperFn } from '../types';

export class HelperMSSQL implements HelperFn {
	private knex: Knex;

	constructor(knex: Knex) {
		this.knex = knex;
	}

	year(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(year, ??.??)', [table, column]);
	}

	month(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(month, ??.??)', [table, column]);
	}

	week(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(week, ??.??)', [table, column]);
	}

	day(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(day, ??.??)', [table, column]);
	}

	weekday(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(weekday, ??.??)', [table, column]);
	}

	hour(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(hour, ??.??)', [table, column]);
	}

	minute(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(minute, ??.??)', [table, column]);
	}

	second(table: string, column: string): Knex.Raw {
		return this.knex.raw('DATEPART(second, ??.??)', [table, column]);
	}
}
