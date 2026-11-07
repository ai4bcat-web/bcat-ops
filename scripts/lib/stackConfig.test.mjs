import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION, assertStackSafe, discoverRehearsal, resolveStack, selectedStackName } from './stackConfig.mjs';
import { PROD_SUFFIX, classifySuffix, resolveProdSuffix, DEV_SUFFIX } from './prodGate.mjs';

const REH = {
  root: 'amplify-d3dejqzs77khq6-rehearsal-branch-abc123def4',
  api: 'rehapi0000000000000000000a',
  staffPool: 'us-east-1_RehStaff1', staffClient: 'rehstaffclient000000000000',
  driverPool: 'us-east-1_RehDrive1', driverClient: 'rehdriverclient00000000000',
  bucket: 'amplify-d3dejqzs77khq6-re-bcatrateconfirmsbucketf4-rehbucket01',
};

/** A fake `aws` CLI shaped like the rehearsal branch's CloudFormation tree. `over` patches the answers. */
function fakeAws(over = {}) {
  const calls = [];
  const aws = (args) => {
    calls.push(args.join(' '));
    const [svc, op] = args;
    const stack = args[args.indexOf('--stack-name') + 1];
    if (svc === 'cloudformation' && op === 'list-stacks') {
      return { StackSummaries: over.stacks ?? [{ StackName: REH.root, StackStatus: 'CREATE_COMPLETE', CreationTime: '2026-11-07T20:00:00Z' }] };
    }
    if (svc === 'cloudformation' && op === 'list-stack-resources') {
      if (stack === REH.root) {
        return { StackResourceSummaries: ['auth', 'data', 'storage'].map((k) => ({ ResourceType: 'AWS::CloudFormation::Stack', LogicalResourceId: `${k}XYZ`, PhysicalResourceId: `child-${k}` })) };
      }
      if (stack === 'child-auth') {
        return { StackResourceSummaries: [
          { ResourceType: 'AWS::Cognito::UserPool', LogicalResourceId: 'amplifyAuthUserPool', PhysicalResourceId: over.staffPool ?? REH.staffPool },
          { ResourceType: 'AWS::Cognito::UserPoolClient', LogicalResourceId: 'amplifyAuthUserPoolAppClient', PhysicalResourceId: over.staffClient ?? REH.staffClient },
        ] };
      }
      if (stack === 'child-data') {
        return { StackResourceSummaries: [
          { ResourceType: 'AWS::Cognito::UserPool', LogicalResourceId: 'BcatDriverPoolFAF3AFEE', PhysicalResourceId: REH.driverPool },
          { ResourceType: 'AWS::Cognito::UserPoolClient', LogicalResourceId: 'BcatDriverPoolClient2E1', PhysicalResourceId: REH.driverClient },
          { ResourceType: 'AWS::AppSync::GraphQLApi', LogicalResourceId: 'amplifyDataGraphQLAPI', PhysicalResourceId: `arn:aws:appsync:us-east-1:1:apis/${over.api ?? REH.api}` },
          { ResourceType: 'AWS::Lambda::Url', LogicalResourceId: 'TrackingApiUrl59F', PhysicalResourceId: 'arn:aws:lambda:us-east-1:1:function:track' },
        ] };
      }
      return { StackResourceSummaries: [{ ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'bcatRateConfirmsBucketF4F6302F', PhysicalResourceId: REH.bucket }] };
    }
    if (svc === 'appsync') return { graphqlApi: { uris: { GRAPHQL: `https://rehearsalappsync.appsync-api.us-east-1.amazonaws.com/graphql` } } };
    if (svc === 'lambda') return { FunctionUrl: 'https://rehpublic.lambda-url.us-east-1.on.aws/' };
    throw new Error(`unexpected aws ${args.join(' ')}`);
  };
  aws.calls = calls;
  return aws;
}
const tmpCache = () => join(mkdtempSync(join(tmpdir(), 'stackcfg-')), 'cache.json');

describe('BCAT_STACK selection', () => {
  it('defaults to dev and accepts only dev or rehearsal; production is never a value', () => {
    expect(selectedStackName({})).toBe('dev');
    expect(selectedStackName({ BCAT_STACK: '' })).toBe('dev');
    expect(selectedStackName({ BCAT_STACK: 'dev' })).toBe('dev');
    expect(selectedStackName({ BCAT_STACK: 'rehearsal' })).toBe('rehearsal');
    for (const bad of ['prod', 'production', 'main', 'Rehearsal', 'dev,rehearsal']) {
      expect(() => selectedStackName({ BCAT_STACK: bad })).toThrow(/must be one of dev\|rehearsal/);
    }
  });

  it('dev resolves to the long-standing constants without touching AWS', () => {
    const dev = resolveStack('dev', { aws: () => { throw new Error('dev must not call aws'); } });
    expect(dev.tableSuffix).toBe(DEV_SUFFIX);
    expect(dev.staffPoolId).toBe('us-east-1_UKhMNVAG1');
    expect(dev.origin).toBe('https://dev.d3dejqzs77khq6.amplifyapp.com');
  });
});

describe('rehearsal discovery', () => {
  it('resolves every id from the rehearsal root stack, derives the suffix from the AppSync id, and caches it', () => {
    const cacheFile = tmpCache();
    const aws = fakeAws();
    const cfg = resolveStack('rehearsal', { aws, cacheFile, env: {} });
    expect(cfg).toMatchObject({
      name: 'rehearsal', origin: 'https://rehearsal.d3dejqzs77khq6.amplifyapp.com', tableSuffix: `${REH.api}-NONE`,
      staffPoolId: REH.staffPool, staffClientId: REH.staffClient, driverPoolId: REH.driverPool, driverClientId: REH.driverClient,
      filesBucket: REH.bucket, publicApi: 'https://rehpublic.lambda-url.us-east-1.on.aws', lambdaPrefix: 'amplify-d3dejqzs77khq6-re',
    });
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).rehearsal.apiId).toBe(REH.api);
    const second = fakeAws();
    expect(resolveStack('rehearsal', { aws: second, cacheFile, env: {} }).apiId).toBe(REH.api);
    expect(second.calls).toEqual([]);
    expect(resolveStack('rehearsal', { aws: second, cacheFile, env: { BCAT_STACK_REFRESH: '1' } }).apiId).toBe(REH.api);
    expect(second.calls.length).toBeGreaterThan(0);
  });

  it('never matches the dev or main root stacks and refuses a stack that is not deployed yet', () => {
    const others = [
      { StackName: 'amplify-d3dejqzs77khq6-dev-branch-f0946a5a1f', StackStatus: 'UPDATE_COMPLETE' },
      { StackName: 'amplify-d3dejqzs77khq6-main-branch-0feb70fa58', StackStatus: 'UPDATE_COMPLETE' },
    ];
    expect(() => discoverRehearsal(fakeAws({ stacks: others }))).toThrow(/has not finished its first backend deploy/);
    expect(() => discoverRehearsal(fakeAws({ stacks: [{ StackName: REH.root, StackStatus: 'CREATE_IN_PROGRESS' }] }))).toThrow(/not deployed yet/);
  });

  it('refuses a discovery that lands on a production id and does not cache it', () => {
    const cacheFile = tmpCache();
    expect(() => resolveStack('rehearsal', { aws: fakeAws({ staffPool: PRODUCTION.staffPoolId }), cacheFile, env: {} })).toThrow(/PRODUCTION/);
    expect(() => resolveStack('rehearsal', { aws: fakeAws({ api: PRODUCTION.apiId }), cacheFile, env: {} })).toThrow(/PRODUCTION AppSync id/);
    expect(() => readFileSync(cacheFile, 'utf8')).toThrow();
  });

  it('refuses a discovery that lands on the dev stack, and ignores a poisoned cache', () => {
    expect(() => resolveStack('rehearsal', { aws: fakeAws({ staffPool: 'us-east-1_UKhMNVAG1' }), cacheFile: tmpCache(), env: {} })).toThrow(/DEV value/);
    const cacheFile = tmpCache();
    const good = resolveStack('rehearsal', { aws: fakeAws(), cacheFile, env: {} });
    writeFileSync(cacheFile, JSON.stringify({ rehearsal: { ...good, staffPoolId: PRODUCTION.staffPoolId } }));
    const aws = fakeAws();
    expect(resolveStack('rehearsal', { aws, cacheFile, env: {} }).staffPoolId).toBe(REH.staffPool);
    expect(aws.calls.length).toBeGreaterThan(0);
  });
});

describe('assertStackSafe: production is refused whatever the stack claims to be', () => {
  const good = () => resolveStack('rehearsal', { aws: fakeAws(), cacheFile: tmpCache(), env: {} });
  it.each([
    ['staff pool', { staffPoolId: PRODUCTION.staffPoolId }],
    ['staff client', { staffClientId: PRODUCTION.staffClientId }],
    ['driver pool', { driverPoolId: PRODUCTION.driverPoolId }],
    ['files bucket', { filesBucket: PRODUCTION.filesBucket }],
    ['production origin', { origin: 'https://ops.bcatcorp.com' }],
    ['main amplify origin', { origin: 'https://main.d3dejqzs77khq6.amplifyapp.com' }],
    ['table suffix', { tableSuffix: PROD_SUFFIX, apiId: PRODUCTION.apiId }],
    ['lambda prefix', { lambdaPrefix: 'amplify-d3dejqzs77khq6-ma' }],
  ])('rejects a rehearsal carrying the production %s', (_n, over) => {
    expect(() => assertStackSafe({ ...good(), ...over })).toThrow();
  });

  it('accepts the unmodified rehearsal', () => {
    expect(() => assertStackSafe(good())).not.toThrow();
  });
});

describe('prodGate: the rehearsal suffix is accepted only when BCAT_STACK selected it', () => {
  const rehearsalSuffix = `${REH.api}-NONE`;
  it('is unknown by default, and a production suffix is production in both modes', () => {
    expect(classifySuffix(rehearsalSuffix)).toBe('unknown');
    expect(classifySuffix(rehearsalSuffix, null)).toBe('unknown');
    expect(classifySuffix(DEV_SUFFIX)).toBe('dev');
    for (const mode of [null, rehearsalSuffix]) {
      expect(classifySuffix(PROD_SUFFIX, mode)).toBe('prod');
      expect(classifySuffix(`${PROD_SUFFIX}-rhabc`, mode)).toBe('prod');
      expect(classifySuffix(`Load-${PROD_SUFFIX}`, mode)).toBe('prod');
    }
  });

  it('classifies exactly the selected rehearsal suffix as rehearsal when the env selected it', () => {
    expect(classifySuffix(rehearsalSuffix, rehearsalSuffix)).toBe('rehearsal');
    expect(classifySuffix(`${rehearsalSuffix}-x`, rehearsalSuffix)).toBe('unknown');
    expect(classifySuffix(PROD_SUFFIX, PROD_SUFFIX)).toBe('prod');
  });

  it('the prod-mode seam takes the rehearsal suffix only with the selector, never production', () => {
    expect(() => resolveProdSuffix({ 'prod-mode-rehearsal-suffix': rehearsalSuffix })).toThrow(/never production/);
    expect(() => resolveProdSuffix({ 'prod-mode-rehearsal-suffix': PROD_SUFFIX })).toThrow(/never production/);
    expect(resolveProdSuffix({ 'prod-mode-rehearsal-suffix': DEV_SUFFIX })).toEqual({ suffix: DEV_SUFFIX, rehearsal: true });
  });
});
