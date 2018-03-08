/// <reference path="./android.def.d.ts" />
import { AggregateBy, Common, HealthDataApi, HealthDataType, QueryRequest, ResponseItem } from './health-data.common';
import * as utils from 'tns-core-modules/utils/utils';
import { ad } from 'tns-core-modules/utils/utils';
import * as application from 'tns-core-modules/application';
import getApplicationContext = ad.getApplicationContext;

const GOOGLE_FIT_PERMISSIONS_REQUEST_CODE = 2;

declare const com: any;

// android imports
const DataReadRequest = com.google.android.gms.fitness.request.DataReadRequest;
const DataType = com.google.android.gms.fitness.data.DataType;
const Fitness = com.google.android.gms.fitness.Fitness;
const GoogleApiAvailability = com.google.android.gms.common.GoogleApiAvailability;
const TimeUnit = java.util.concurrent.TimeUnit;
const FitnessOptions = com.google.android.gms.fitness.FitnessOptions;
const GoogleSignIn = com.google.android.gms.auth.api.signin.GoogleSignIn;

export class HealthData extends Common implements HealthDataApi {
  isAvailable(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const gApi = GoogleApiAvailability.getInstance();
      const apiResult = gApi.isGooglePlayServicesAvailable(utils.ad.getApplicationContext());
      const available = apiResult === com.google.android.gms.common.ConnectionResult.SUCCESS;
      if (!available && gApi.isUserResolvableError(apiResult)) {
        // show a dialog offering the user to update (no need to wait for it to finish)
        gApi.showErrorDialogFragment(application.android.foregroundActivity, apiResult, 1, new android.content.DialogInterface.OnCancelListener({
          onCancel: dialogInterface => console.log("Google Play Services update dialog was canceled")
        }));
      }
      resolve(available);
    });
  }

  isAuthorized(types: Array<HealthDataType>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const fitnessOptionsBuilder = FitnessOptions.builder();

      types.filter(t => t.accessType === "read" || t.accessType === "readAndWrite")
          .forEach(t => fitnessOptionsBuilder.addDataType(this.getDataType(t.name), FitnessOptions.ACCESS_READ));
      types.filter(t => t.accessType === "write" || t.accessType === "readAndWrite")
          .forEach(t => fitnessOptionsBuilder.addDataType(this.getDataType(t.name), FitnessOptions.ACCESS_WRITE));

      resolve(GoogleSignIn.hasPermissions(
          GoogleSignIn.getLastSignedInAccount(application.android.currentContext),
          fitnessOptionsBuilder.build()));
    });
  }

  requestAuthorization(types: Array<HealthDataType>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const fitnessOptionsBuilder = FitnessOptions.builder();

      types.filter(t => t.accessType === "read" || t.accessType === "readAndWrite")
          .forEach(t => fitnessOptionsBuilder.addDataType(this.getDataType(t.name), FitnessOptions.ACCESS_READ));
      types.filter(t => t.accessType === "write" || t.accessType === "readAndWrite")
          .forEach(t => fitnessOptionsBuilder.addDataType(this.getDataType(t.name), FitnessOptions.ACCESS_WRITE));

      const fitnessOptions = fitnessOptionsBuilder.build();

      if (GoogleSignIn.hasPermissions(GoogleSignIn.getLastSignedInAccount(application.android.currentContext), fitnessOptions)) {
        resolve(true);
        return;
      }

      const activityResultHandler = (args: application.AndroidActivityResultEventData) => {
        application.android.off(application.AndroidApplication.activityResultEvent, activityResultHandler);
        resolve(args.requestCode === GOOGLE_FIT_PERMISSIONS_REQUEST_CODE && args.resultCode === android.app.Activity.RESULT_OK);
      };
      application.android.on(application.AndroidApplication.activityResultEvent, activityResultHandler);

      GoogleSignIn.requestPermissions(
          application.android.foregroundActivity,
          GOOGLE_FIT_PERMISSIONS_REQUEST_CODE,
          GoogleSignIn.getLastSignedInAccount(application.android.currentContext),
          fitnessOptions);
    });
  }

  // TODO how does Fit deal with unit conversion? mi <----> km, and such
  query(opts: QueryRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const readRequest = new DataReadRequest.Builder()
        // using 'read' instead of 'aggregate' for now, for more finegrain control
        //     .aggregate(DataType.TYPE_STEP_COUNT_DELTA, DataType.AGGREGATE_STEP_COUNT_DELTA)
        //     .bucketByTime(1, TimeUnit.HOURS)
            .read(this.getDataType(opts.dataType))
            .setTimeRange(opts.startDate.getTime(), opts.endDate.getTime(), TimeUnit.MILLISECONDS)
            .build();

        Fitness.getHistoryClient(application.android.currentContext, GoogleSignIn.getLastSignedInAccount(application.android.currentContext))
            .readData(readRequest)
            .addOnSuccessListener(new com.google.android.gms.tasks.OnSuccessListener({
              onSuccess: (dataReadResponse: any /* com.google.android.gms.fitness.result.DataReadResponse */) => {
                resolve(this.parseData(dataReadResponse.getResult(), opts.aggregateBy));
              }
            }))
            .addOnFailureListener(new com.google.android.gms.tasks.OnFailureListener({
              onFailure: (exception: any) => {
                reject(exception.getMessage());
              }
            }))
            .addOnCompleteListener(new com.google.android.gms.tasks.OnCompleteListener({
              onComplete: (task: any) => {
                // noop
              }
            }));
      } catch (e) {
        reject(e);
      }
    });
  }

  private parseData(readResult: com.google.android.gms.fitness.result.DataReadResult, aggregateBy?: AggregateBy) {
    let result = [];
    if (readResult.getBuckets().size() > 0) {
      for (let indexBucket = 0; indexBucket < readResult.getBuckets().size(); indexBucket++) {
        let dataSets = readResult.getBuckets().get(indexBucket).getDataSets();
        for (let indexDataSet = 0; indexDataSet < dataSets.size(); indexDataSet++) {
          result = result.concat(this.dumpDataSet(dataSets.get(indexDataSet), aggregateBy));
        }
      }
    } else if (readResult.getDataSets().size() > 0) {
      for (let index = 0; index < readResult.getDataSets().size(); index++) {
        result = result.concat(this.dumpDataSet(readResult.getDataSets().get(index), aggregateBy));
      }
    }
    return result;
  }

  private dumpDataSet(dataSet: com.google.android.gms.fitness.data.DataSet, aggregateBy?: AggregateBy) {
    const parsedData: Array<ResponseItem> = [];
    const packageManager = getApplicationContext().getPackageManager();
    const packageToAppNameCache = new Map<string, string>();

    for (let index = 0; index < dataSet.getDataPoints().size(); index++) {
      const pos = dataSet.getDataPoints().get(index);

      for (let indexField = 0; indexField < pos.getDataType().getFields().size(); indexField++) {
        let field = pos.getDataType().getFields().get(indexField);
        const value = pos.getValue(field);

        const packageName = pos.getOriginalDataSource().getAppPackageName();
        let source = packageName ? packageName : pos.getOriginalDataSource().getStreamName();
        if (packageName) {
          if (!packageToAppNameCache.has(packageName)) {
            try {
              const appName = packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, android.content.pm.PackageManager.GET_META_DATA));
              packageToAppNameCache.set(packageName, appName);
            } catch (ignore) {
              // the app has probably been unsintalled, so use the package name
              packageToAppNameCache.set(packageName, packageName);
            }
          }
          source = packageToAppNameCache.get(packageName);
        }

        parsedData.push(<ResponseItem>{
          start: new Date(pos.getStartTime(TimeUnit.MILLISECONDS)),
          end: new Date(pos.getEndTime(TimeUnit.MILLISECONDS)),
          // https://developers.google.com/android/reference/com/google/android/gms/fitness/data/Value
          value: value.getFormat() === 1 ? value.asInt() : value.asFloat(),
          source: source
        });
      }
    }

    return this.aggregate(parsedData, aggregateBy);
  }

  private getDataType(pluginType: string): com.google.android.gms.fitness.data.DataType {
    // TODO check if the passed type is ok
    const typeOfData = acceptableDataTypesForCommonity[pluginType];
    return aggregatedDataTypes[typeOfData];
  }
}

const aggregatedDataTypes = {
  TYPE_STEP_COUNT_DELTA: DataType.AGGREGATE_STEP_COUNT_DELTA,
  TYPE_DISTANCE_DELTA: DataType.AGGREGATE_DISTANCE_DELTA,
  TYPE_CALORIES_EXPENDED: DataType.AGGREGATE_CALORIES_EXPENDED,
  TYPE_HEIGHT: DataType.TYPE_HEIGHT, // TODO or AGGREGATE_HEIGHT_SUMMARY
  TYPE_WEIGHT: DataType.AGGREGATE_WEIGHT_SUMMARY,
  TYPE_HEART_RATE_BPM: DataType.AGGREGATE_HEART_RATE_SUMMARY,
  TYPE_BODY_FAT_PERCENTAGE: DataType.AGGREGATE_BODY_FAT_PERCENTAGE_SUMMARY,
  TYPE_NUTRITION: DataType.AGGREGATE_NUTRITION_SUMMARY
};

const acceptableDataTypesForCommonity = {
  steps: 'TYPE_STEP_COUNT_DELTA',
  distance: 'TYPE_DISTANCE_DELTA',
  calories: 'TYPE_CALORIES_EXPENDED',
  // "activity": DataType.TYPE_ACTIVITY_SEGMENT,
  height: 'TYPE_HEIGHT',
  weight: 'TYPE_WEIGHT',
  heartRate: 'TYPE_HEART_RATE_BPM',
  fatPercentage: 'TYPE_BODY_FAT_PERCENTAGE'
  // "nutrition": "TYPE_NUTRITION",
};
