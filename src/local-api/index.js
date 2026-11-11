// Answers requests to `localApi.url` in the browser (see api.js) by putting an
// adapter in front of axios's own; every other request goes out as before.
// Enabled with the config option `localApi: { url, collectionsUrl }`.
import axios, { AxiosError, AxiosHeaders } from 'axios';
import LocalApi from './api';

export function installLocalApi(config) {
  const options = config.localApi;
  if (!options || !options.url || !options.collectionsUrl) {
    return null;
  }
  const api = new LocalApi(options);
  const network = axios.getAdapter(axios.defaults.adapter);
  const root = new URL(options.url.replace(/\/*$/, '/'));

  axios.defaults.adapter = async (cfg) => {
    const url = new URL(axios.getUri(cfg), window.location.href);
    const inApi = url.origin === root.origin
      && (url.pathname === root.pathname.replace(/\/$/, '') || url.pathname.startsWith(root.pathname));
    if (!inApi) {
      return network(cfg);
    }
    const method = (cfg.method || 'get').toUpperCase();
    const response = (status, data) => ({
      data, status, statusText: status === 200 ? 'OK' : 'Error', config: cfg, request: {},
      headers: new AxiosHeaders({ 'content-type': 'application/json' }),
    });
    if (method === 'OPTIONS' || method === 'HEAD') {
      return response(200, null);
    }
    try {
      let params = Object.fromEntries(url.searchParams);
      if (method === 'POST' && cfg.data) {
        params = Object.assign(params, typeof cfg.data === 'string' ? JSON.parse(cfg.data) : cfg.data);
      }
      const path = url.pathname.slice(root.pathname.length);
      return response(200, await api.handle(method, path, params));
    }
    catch (error) {
      const status = error.status || 500;
      const res = response(status, { code: status === 404 ? 'NotFound' : 'Error', description: error.message });
      throw new AxiosError(error.message, status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE, cfg, null, res);
    }
  };
  return api;
}
