import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { EAGLEPlatform } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, EAGLEPlatform);
};
