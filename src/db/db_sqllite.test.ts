import { Forecast } from './db';
import { LiteDB } from './db_sqlite';

describe('SQlite memory test', () => {
  it('Sqlite save', async () => {
    const db = new LiteDB(':memory:');

    const testData: Forecast = {
      time: new Date(),
      obj: {
        text: 'aaaa',
      },
    };

    expect(db.Save(testData)).toBe(true);

    const loaded = await db.Load();

    expect(loaded).toStrictEqual(testData);
  });
});
